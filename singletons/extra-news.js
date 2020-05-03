/* global sb */
module.exports = (function (Module) {
	"use strict";

	const RSS = new (require("rss-parser"))();

	/**
	 * Extra news module, for countries that are not included in the news command.
	 * Constructor must be await-ed.
	 * @name sb.ExtraNews
	 * @type ExtraNews()
	 */
	return class ExtraNews extends Module {
		#tableExists;

		/**
		 * @inheritDoc
		 * @returns {ExtraNews}
		 */
		static async singleton () {
			if (!ExtraNews.module) {
				ExtraNews.module = await new ExtraNews();
			}
			return ExtraNews.module;
		}

		constructor () {
			super();
			this.data = {};
			return this.loadData();
		}

		check (code) {
			code = code.toLowerCase();
			for (const row of this.data) {
				if (row.Code === code) {
					return true;
				}
			}
			return false;
		}

		async fetch (code, query = null) {
			code = code.toLowerCase();

			const row = this.data.find(i => i.Code === code);
			if (!row) {
				throw new sb.Error({ message: "Extra news code does not exist!" });
			}

			const url = row.URL + sb.Utils.randArray(row.Endpoints);
			const feed = await RSS.parseURL(url);

			if (query) {
				query = query.toLowerCase();
				feed.items = feed.items.filter(i => (
					i.title && i.title.toLowerCase().includes(query)
					|| i.content && i.content.toLowerCase().includes(query)
				));
			}

			const article = sb.Utils.randArray(feed.items);
			if (!article) {
				return null;
			}

			return {
				title: article.title,
				content: article.content,
				link: article.link || article.url,
				published: new sb.Date(article.pubDate)
			};
		}

		/**
		 * Loads the configuration from database.
		 * @returns {Promise<ExtraNews>}
		 */
		async loadData () {
			if (typeof this.#tableExists !== "boolean") {
				this.#tableExists = await sb.Query.isTablePresent("data", "Extra_News");
			}

			if (this.#tableExists) {
				const data = await sb.Query.getRecordset(rs => rs
					.select("*")
					.from("data", "Extra_News")
				);

				this.data = data.map(row => {
					row.Endpoints = JSON.parse(row.Endpoints);
					return row;
				});
			}
			else {
				this.data = [];
			}

			return this;
		}

		/**
		 * Reloads the configuration.
		 * @returns {Promise<Config>}
		 */
		async reloadData () {
			this.data = {};
			await this.loadData();
		}

		get modulePath () { return "extra-news"; }

		/** @inheritDoc */
		destroy () {
			this.data = [];
		}
	};
});