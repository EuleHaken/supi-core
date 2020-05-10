/* global sb */
module.exports = (function (Module) {
	"use strict";
	const Maria = require("mariadb");
	const Batch = require("./batch.js");
	const Recordset = require("./recordset.js");
	const RecordDeleter = require("./record-deleter.js");
	const RecordUpdater = require("./record-updater.js");
	const Row = require("./row.js");

	const updateBatchLimit = 1000;
	const formatSymbolRegex = /%(s\+|n\+|b|dt|d|n|p|s|t|\*?like\*?)/g;
	
	/**
	 * Query represents every possible access to the database.
	 * Exposes multiple ways to access:
	 * {@link Row}: Single table row, select/insert/update/delete
	 * {@link Recordset}: Result of a compound SELECT statement
	 * {@link Batch}: A tool to INSERT multiple rows in one statement, for specified columns
	 * {@link RecordUpdater}: UPDATEs specified columns with values, with specified condition(s)
	 * @name sb.Query
	 * @type Query()
	 */
	return class Query extends Module {
		/**
		 * @inheritDoc
		 * @returns {Query}
		 */
		static singleton () {
			if (!Query.module) {
				Query.module = new Query();
			}
			return Query.module;
		}

		constructor () {
			super();

			if (!process.env.MARIA_USER || !process.env.MARIA_PASSWORD || (!process.env.MARIA_HOST && !process.env.MARIA_SOCKET_PATH)) {
				throw new sb.Error({ message: "Database access must be initialized first" });
			}

			/** @type {TableDefinition[]} */
			this.tableDefinitions = [];

			if (process.env.MARIA_SOCKET_PATH) {
				this.pool = Maria.createPool({
					socketPath: "/var/run/mysqld/mysqld.sock",
					user: process.env.MARIA_USER,
					password: process.env.MARIA_PASSWORD,
					connectionLimit: process.env.MARIA_CONNECTION_LIMIT || 300,
					multipleStatements: true
				});
			}
			else if (process.env.MARIA_HOST) {
				this.pool = Maria.createPool({
					user: process.env.MARIA_USER,
					host: process.env.MARIA_HOST,
					password: process.env.MARIA_PASSWORD,
					connectionLimit: process.env.MARIA_CONNECTION_LIMIT || 300,
					multipleStatements: true
				});
			}
			else {
				throw new sb.Error({
					message: "Not enough info provided in process.env for Query to initialize"
				})
			}
		}

		/**
		 * Executes a raw SQL query.
		 * @param {...string} args
		 * @returns {Promise<*>}
		 */
		async raw (...args) {
			const query = args.join("\n");
			const connector = await this.pool.getConnection();

			const result = connector.query({
				sql: query,
				multipleStatements: true
			});
			await connector.end();

			return result;
		}

		/**
		 * @alias Query.raw
		 */
		async send (...args) {
			return this.raw(...args);
		}

		/**
		 * Prepares a transaction for next use.
		 * Transaction must be commited/rollbacked manually afterwards.
		 * @returns {Promise<*>}
		 */
		async getTransaction () {
			const connector = await this.pool.getConnection();
			connector.beginTransaction();
			return connector;
		}

		/**
		 * Creates a new Recordset instance.
		 * @param {RecordsetCallback} callback
		 * @returns {Promise<Array>}
		 */
		async getRecordset (callback) {
			const rs = new Recordset(this);
			callback(rs);
			return await rs.fetch();
		}

		/**
		 * Creates a new RecordDeleter instance.
		 * @param callback
		 * @returns {Promise<*>}
		 */
		async getRecordDeleter (callback) {
			const rd = new RecordDeleter(this);
			callback(rd);
			return await rd.fetch();
		}

		/**
		 * Creates a new RecordUpdater instance.
		 * @param {RecordsetCallback} callback
		 * @returns {Promise<Array>}
		 */
		async getRecordUpdater (callback) {
			const ru = new RecordUpdater(this);
			callback(ru);
			return await ru.fetch();
		}

		async batchUpdate (data, callback) {
			const queries = await Promise.all(data.map(async row => {
				const ru = new RecordUpdater(this);
				callback(ru, row);

				const sql = await ru.toSQL();
				return sql.join(" ") + ";";
			}));

			for (let i = 0; i <= queries.length; i += updateBatchLimit) {
				const transaction = await this.getTransaction();
				const slice = queries.slice(i, i + updateBatchLimit);

				try {
					await transaction.query(slice.join("\n"));
					await transaction.commit();
				}
				catch {
					await transaction.rollback();
				}
			}
		}

		/**
		 * Returns a boolean determining if a given database (schema) - table combination exists.
		 * @param {string} database
		 * @param {string} table
		 * @returns {Promise<boolean>}
		 */
		async isTablePresent (database, table) {
			const exists = await this.getRecordset(rs => rs
				.select("1")
				.from("INFORMATION_SCHEMA", "TABLES")
				.where("TABLE_SCHEMA = %s", database)
				.where("TABLE_NAME = %s", table)
			);

			return (exists.length !== 0);
		}

		/**
		 * Creates a condition string, based on the same syntax Recordset uses
		 * @param {Function} callback
		 * @returns {string}
		 */
		getCondition (callback) {
			const rs = new Recordset(this);
			callback(rs);
			return rs.toCondition();
		}

		/**
		 * Creates a new Row instance.
		 * @param {string} database Database of the table
		 * @param {string} table Name of the table
		 * @returns {Promise<Row>}
		 */
		async getRow (database, table) {
			return await new Row(this, database, table);
		}

		/**
		 * Returns a new Batch instance.
		 * @param {string} database Database of the table
		 * @param {string} table Name of the table
		 * @param {string[]} columns Column names to insert into given table
		 * @returns {Promise<Batch>}
		 */
		async getBatch (database, table, columns) {
			return await new Batch(this, database, table, columns);
		}

		/**
		 * Fetches the definition of a specific table.
		 * @param {string} database
		 * @param {string} table
		 * @returns {Promise<TableDefinition>}
		 */
		async getDefinition (database, table) {
			if (this.tableDefinitions[database] && this.tableDefinitions[database][table]) {
				return this.tableDefinitions[database][table];
			}

			const path = this.escapeIdentifier(database) + "." + this.escapeIdentifier(table);
			const escapedPath = "`" + this.escapeIdentifier(database) + "`.`" + this.escapeIdentifier(table) + "`";
			this.tableDefinitions[database] = this.tableDefinitions[database] || {};
			let obj = {
				name: table,
				database: database,
				path: path,
				escapedPath: escapedPath,
				columns: []
			};

			const data = await this.raw("SELECT * FROM " + path + " WHERE 1 = 0");
			for (const column of data.meta) {
				obj.columns.push({
					name: column.name(),
					type: column.type,
					notNull: !!(column.flags & Query.flagMask["NOT_NULL"]),
					primaryKey: !!(column.flags & Query.flagMask["PRIMARY_KEY"]),
					unsigned: !!(column.flags & Query.flagMask["UNSIGNED"])
				});
			}

			this.tableDefinitions[database][table] = obj;
			return this.tableDefinitions[database][table];
		}

		/**
		 * Invalidates a specific table definition.
		 * The next time it is accessed, it will be refreshed.
		 * @param {string} database Database of table
		 * @param {string} table Name of table
		 */
		invalidateDefinition (database, table) {
			if (this.tableDefinitions[database] && this.tableDefinitions[database][table]) {
				this.tableDefinitions[database][table] = null;
			}
		}

		/**
		 * Invalidates all table definitions.
		 * The next time they're accessed, they will be refreshed.
		 */
		invalidateAllDefinitions () {
			this.tableDefinitions = [];
		}

		/**
		 * Converts a SQL value and type to a Javascript value
		 * SQL TINYINT(1) -> JS boolean
		 * SQL DATE/DATETIME/TIMESTAMP -> JS sb.Date
		 * SQL JSON -> JS Object
		 * SQL *INT/*TEXT/*CHAR -> JS number/string
		 * @param {*} value
		 * @param {string} type
		 * @returns {*}
		 */
		convertToJS (value, type) {
			if (value === null) {
				return value;
			}

			switch (type) {
				case "TINY": return (value === 1);

				// case "TIME":
				case "DATE":
				case "DATETIME":
				case "TIMESTAMP": return new sb.Date(value);

				case "LONGLONG": return BigInt(value);

				case "JSON": return JSON.parse(value);

				default: return value;
			}
		}

		/**
		 * Converts a Javascript value to its SQL counterpart
		 * JS null -> SQL NULL
		 * JS boolean -> SQL TINYINT(1)
		 * JS Date/sb.Date -> SQL TIME/DATE/DATETIME/TIMESTAMP
		 * JS string -> escaped SQL VARCHAR/*TEXT
		 * JS number -> SQL *INT
		 * @param {*} value Javascript value to convert
		 * @param {string} targetType Target SQL type
		 * @returns {*} Properly formatted SQL value
		 * @throws {sb.Error} If a type mismatch is encountered
		 */
		convertToSQL (value, targetType) {
			let sourceType = typeof value;

			if (value === null) {
				return "NULL";
			}
			else if (targetType === "TINY") {
				if (sourceType !== "boolean") {
					throw new sb.Error({
						message: "Expected value type: boolean",
						args: value
					});
				}

				return (value === true) ? "1" : "0";
			}
			else if (targetType === "SET" && Array.isArray(value)) {
				const string = this.escapeString(value.join(","));
				return `'${string}'`;
			}
			else if (targetType === "TIME" || targetType === "DATE" || targetType === "DATETIME" || targetType === "TIMESTAMP")  {
				if (value instanceof Date) {
					value = new sb.Date(value);
				}

				if (!(value instanceof sb.Date)) {
					throw new sb.Error({
						message: "Expected value type: date",
						args: value
					});
				}

				switch (targetType) {
					case "TIME": return "'" + value.sqlTime() + "'";
					case "DATE": return "'" +  value.sqlDate() + "'";
					case "DATETIME": return "'" +  value.sqlDateTime() + "'";
					case "TIMESTAMP": return "'" +  value.sqlDateTime() + "'";
				}
			}
			else if (sourceType === "string") {
				return "'" + this.escapeString(value) + "'";
			}
			else {
				return value;
			}
		}

		escapeIdentifier (string) {
			// @todo figure this out

			// // console.log("escape identifier", "`" + string.replace(/^`|`$/g, "").replace(/`/g, "``") + "`");
			// const result = (/\*$/.test(string))
			// 	? string
			// 	: "`" + string.replace(/^`|`$/g, "").replace(/`/g, "``") + "`";
			//

			if (typeof string === "string" && string.includes("chatrooms")) {
				string = "`" + string + "`"
			}

			// console.warn(string);

			return string;

			// return string;

			// return "`" + string.replace(/^`|`$/g, "").replace(/`/g, "``") + "`";
			// return "`" + string.replace(/^`|`$/g, "").replace(/`/g, "\\`") + "`";
		}

		/**
		 * Escapes a string to be SQL-compliant
		 * @param string
		 * @returns {string}
		 */
		escapeString (string) {
			return string.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "\\\"");
		}

		/**
		 * Escapes a LIKE string to be SQL-compliant - makes sure to keep % characters in correct places
		 * @param string
		 * @returns {string}
		 */
		escapeLikeString (string) {
			return this.escapeString(string).replace(/%/g, "\\%").replace(/_/g, "\\_");
		}

		/**
		 * Replaces format symbols used in WHERE/HAVING with their provided values and escapes/parses them.
		 * @private
		 * @param {string} type
		 * @param {*} param
		 * @returns {string}
		 * @throws {sb.Error} If an unrecognized format symbol was encountered.
		 */
		parseFormatSymbol (type, param) {
			switch (type) {
				case "b":
					if (typeof param !== "boolean") {
						throw new sb.Error({ message: "Expected boolean, got " + param });	
					} 
					
					return (param ? "1" : "0");

				case "d":
					if (param instanceof Date && !(param instanceof sb.Date)) {
						param = new sb.Date(param);
					}					
					if (!(param instanceof sb.Date)) {
						throw new sb.Error({ message: "Expected sb.Date, got " + param });
					}
					
					return "'" + param.sqlDate() + "'";

				case "dt":
					if (param instanceof Date && !(param instanceof sb.Date)) {
						param = new sb.Date(param);
					}					
					if (!(param instanceof sb.Date)) {
						throw new sb.Error({ message: "Expected sb.Date, got " + param });
					}

					return "'" + param.sqlDateTime() + "'";

				case "n":
					if (typeof param !== "number") {
						throw new sb.Error({ message: "Expected number, got " + param });
					}
					
					return String(param);

				case "s":
					if (typeof param !== "string") {
						throw new sb.Error({ message: "Expected string, got " + param });
					}
					
					return "'" + this.escapeString(param) + "'";

				case "t":
					if (param instanceof Date && !(param instanceof sb.Date)) {
						param = new sb.Date(param);
					}
					if (!(param instanceof sb.Date)) {
						throw new sb.Error({ message: "Expected sb.Date, got " + param });
					}
					
					return param.sqlTime();

				case "s+":
					if (!Array.isArray(param)) {
						throw new sb.Error({ message: "Expected Array, got " + param });
					}
					
					return "(" + param.map(i => this.escapeString(i)).map(i => `'${i}'`).join(",") + ")";

				case "n+":
					if (!Array.isArray(param)) {
						throw new sb.Error({ message: "Expected Array, got " + param });
					}
					
					return "(" + param.join(",") + ")";

				case "*like*":
					if (typeof param !== "string") {
						throw new sb.Error({ message: "Expected string, got " + param });
					}
					
					return " LIKE '%" + this.escapeLikeString(param) + "%'";

				default: throw new sb.Error({
					message: "Unknown Recordset replace parameter",
					args: type
				});
			}
		}
		
		static get sqlKeywords () {
			return [ "SUM", "COUNT", "AVG" ];
		}

		static get flagMask () {
			return {
				"NOT_NULL": 1,
				"PRIMARY_KEY": 2,
				"UNIQUE_KEY": 4,
				"MULTIPLE_KEY": 8,
				"BLOB": 16,
				"UNSIGNED": 32,
				"ZEROFILL_FLAG": 64,
				"BINARY_COLLATION": 128,
				"ENUM": 256,
				"AUTO_INCREMENT": 512,
				"TIMESTAMP": 1024,
				"SET": 2048,
				"NO_DEFAULT_VALUE_FLAG": 4096,
				"ON_UPDATE_NOW_FLAG": 8192,
				"NUM_FLAG": 32768
			};
		}
		
		/**
		 * Regex used to parse out format symbols.
		 * @returns {RegExp}
		 */
		get formatSymbolRegex () {
			return formatSymbolRegex;
		}

		get modulePath () { return "query"; }

		/**
		 * Cleans up.
		 */
		destroy () {
			this.invalidateAllDefinitions();
			this.pool = null;
		}

	};
});

/**
 * @callback RecordsetCallback
 * @param {Recordset} rs
 */

/**
 * @typedef TableDefinition
 * @property {string} database Database of table
 * @property {string} name Name of table
 * @property {string} path {@link TableDefinition#database} . {@link TableDefinition#name}
 * @property {ColumnDefinition[]} columns Column definition
 */

/**
 * @typedef ColumnDefinition
 * @property {string} name Column name
 * @property {string} type Column type
 * @property {boolean} notNull If true, column can be set to null
 * @property {boolean} primaryKey If true, column is the primary key or a part of it
 * @property {boolean} unsigned If true, a numeric column is unsigned
 */

/**
 * @typedef {Object} WhereHavingParams
 * @property {boolean} [condition] If false, WHERE/HAVING will not be executed
 * @property {string} [raw] If present, WHERE/HAVING will not be parsed, and instead will directly use this string
 */

/**
 * @typedef {"%b"|"%d"|"%dt"|"%p"|"%n"|"%s"|"%t"|"%like"|"%*like"|"%like*"|"%*like*"} FormatSymbol
 */