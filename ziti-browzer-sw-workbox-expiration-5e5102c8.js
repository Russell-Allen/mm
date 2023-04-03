define(['exports', './ziti-browzer-sw-workbox-core-12558fbc', './ziti-browzer-sw-misc-c8698879'], (function (exports, zitiBrowzerSwWorkboxCore, zitiBrowzerSwMisc) { 'use strict';

    // @ts-ignore
    try {
        self['workbox:expiration:6.5.1'] && _();
    }
    catch (e) { }

    /*
      Copyright 2018 Google LLC

      Use of this source code is governed by an MIT-style
      license that can be found in the LICENSE file or at
      https://opensource.org/licenses/MIT.
    */
    const DB_NAME = 'workbox-expiration';
    const CACHE_OBJECT_STORE = 'cache-entries';
    const normalizeURL = (unNormalizedUrl) => {
        const url = new URL(unNormalizedUrl, location.href);
        url.hash = '';
        return url.href;
    };
    /**
     * Returns the timestamp model.
     *
     * @private
     */
    class CacheTimestampsModel {
        /**
         *
         * @param {string} cacheName
         *
         * @private
         */
        constructor(cacheName) {
            this._db = null;
            this._cacheName = cacheName;
        }
        /**
         * Performs an upgrade of indexedDB.
         *
         * @param {IDBPDatabase<CacheDbSchema>} db
         *
         * @private
         */
        _upgradeDb(db) {
            // TODO(philipwalton): EdgeHTML doesn't support arrays as a keyPath, so we
            // have to use the `id` keyPath here and create our own values (a
            // concatenation of `url + cacheName`) instead of simply using
            // `keyPath: ['url', 'cacheName']`, which is supported in other browsers.
            const objStore = db.createObjectStore(CACHE_OBJECT_STORE, { keyPath: 'id' });
            // TODO(philipwalton): once we don't have to support EdgeHTML, we can
            // create a single index with the keyPath `['cacheName', 'timestamp']`
            // instead of doing both these indexes.
            objStore.createIndex('cacheName', 'cacheName', { unique: false });
            objStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        /**
         * Performs an upgrade of indexedDB and deletes deprecated DBs.
         *
         * @param {IDBPDatabase<CacheDbSchema>} db
         *
         * @private
         */
        _upgradeDbAndDeleteOldDbs(db) {
            this._upgradeDb(db);
            if (this._cacheName) {
                void zitiBrowzerSwMisc.deleteDB(this._cacheName);
            }
        }
        /**
         * @param {string} url
         * @param {number} timestamp
         *
         * @private
         */
        async setTimestamp(url, timestamp) {
            url = normalizeURL(url);
            const entry = {
                url,
                timestamp,
                cacheName: this._cacheName,
                // Creating an ID from the URL and cache name won't be necessary once
                // Edge switches to Chromium and all browsers we support work with
                // array keyPaths.
                id: this._getId(url),
            };
            const db = await this.getDb();
            const tx = db.transaction(CACHE_OBJECT_STORE, 'readwrite', {
                durability: 'relaxed',
            });
            await tx.store.put(entry);
            await tx.done;
        }
        /**
         * Returns the timestamp stored for a given URL.
         *
         * @param {string} url
         * @return {number | undefined}
         *
         * @private
         */
        async getTimestamp(url) {
            const db = await this.getDb();
            const entry = await db.get(CACHE_OBJECT_STORE, this._getId(url));
            return entry === null || entry === void 0 ? void 0 : entry.timestamp;
        }
        /**
         * Iterates through all the entries in the object store (from newest to
         * oldest) and removes entries once either `maxCount` is reached or the
         * entry's timestamp is less than `minTimestamp`.
         *
         * @param {number} minTimestamp
         * @param {number} maxCount
         * @return {Array<string>}
         *
         * @private
         */
        async expireEntries(minTimestamp, maxCount) {
            const db = await this.getDb();
            let cursor = await db
                .transaction(CACHE_OBJECT_STORE)
                .store.index('timestamp')
                .openCursor(null, 'prev');
            const entriesToDelete = [];
            let entriesNotDeletedCount = 0;
            while (cursor) {
                const result = cursor.value;
                // TODO(philipwalton): once we can use a multi-key index, we
                // won't have to check `cacheName` here.
                if (result.cacheName === this._cacheName) {
                    // Delete an entry if it's older than the max age or
                    // if we already have the max number allowed.
                    if ((minTimestamp && result.timestamp < minTimestamp) ||
                        (maxCount && entriesNotDeletedCount >= maxCount)) {
                        // TODO(philipwalton): we should be able to delete the
                        // entry right here, but doing so causes an iteration
                        // bug in Safari stable (fixed in TP). Instead we can
                        // store the keys of the entries to delete, and then
                        // delete the separate transactions.
                        // https://github.com/GoogleChrome/workbox/issues/1978
                        // cursor.delete();
                        // We only need to return the URL, not the whole entry.
                        entriesToDelete.push(cursor.value);
                    }
                    else {
                        entriesNotDeletedCount++;
                    }
                }
                cursor = await cursor.continue();
            }
            // TODO(philipwalton): once the Safari bug in the following issue is fixed,
            // we should be able to remove this loop and do the entry deletion in the
            // cursor loop above:
            // https://github.com/GoogleChrome/workbox/issues/1978
            const urlsDeleted = [];
            for (const entry of entriesToDelete) {
                await db.delete(CACHE_OBJECT_STORE, entry.id);
                urlsDeleted.push(entry.url);
            }
            return urlsDeleted;
        }
        /**
         * Takes a URL and returns an ID that will be unique in the object store.
         *
         * @param {string} url
         * @return {string}
         *
         * @private
         */
        _getId(url) {
            // Creating an ID from the URL and cache name won't be necessary once
            // Edge switches to Chromium and all browsers we support work with
            // array keyPaths.
            return this._cacheName + '|' + normalizeURL(url);
        }
        /**
         * Returns an open connection to the database.
         *
         * @private
         */
        async getDb() {
            if (!this._db) {
                this._db = await zitiBrowzerSwMisc.openDB(DB_NAME, 1, {
                    upgrade: this._upgradeDbAndDeleteOldDbs.bind(this),
                });
            }
            return this._db;
        }
    }

    /*
      Copyright 2018 Google LLC

      Use of this source code is governed by an MIT-style
      license that can be found in the LICENSE file or at
      https://opensource.org/licenses/MIT.
    */
    /**
     * The `CacheExpiration` class allows you define an expiration and / or
     * limit on the number of responses stored in a
     * [`Cache`](https://developer.mozilla.org/en-US/docs/Web/API/Cache).
     *
     * @memberof workbox-expiration
     */
    class CacheExpiration {
        /**
         * To construct a new CacheExpiration instance you must provide at least
         * one of the `config` properties.
         *
         * @param {string} cacheName Name of the cache to apply restrictions to.
         * @param {Object} config
         * @param {number} [config.maxEntries] The maximum number of entries to cache.
         * Entries used the least will be removed as the maximum is reached.
         * @param {number} [config.maxAgeSeconds] The maximum age of an entry before
         * it's treated as stale and removed.
         * @param {Object} [config.matchOptions] The [`CacheQueryOptions`](https://developer.mozilla.org/en-US/docs/Web/API/Cache/delete#Parameters)
         * that will be used when calling `delete()` on the cache.
         */
        constructor(cacheName, config = {}) {
            this._isRunning = false;
            this._rerunRequested = false;
            this._maxEntries = config.maxEntries;
            this._maxAgeSeconds = config.maxAgeSeconds;
            this._matchOptions = config.matchOptions;
            this._cacheName = cacheName;
            this._timestampModel = new CacheTimestampsModel(cacheName);
        }
        /**
         * Expires entries for the given cache and given criteria.
         */
        async expireEntries() {
            if (this._isRunning) {
                this._rerunRequested = true;
                return;
            }
            this._isRunning = true;
            const minTimestamp = this._maxAgeSeconds
                ? Date.now() - this._maxAgeSeconds * 1000
                : 0;
            const urlsExpired = await this._timestampModel.expireEntries(minTimestamp, this._maxEntries);
            // Delete URLs from the cache
            const cache = await self.caches.open(this._cacheName);
            for (const url of urlsExpired) {
                await cache.delete(url, this._matchOptions);
            }
            this._isRunning = false;
            if (this._rerunRequested) {
                this._rerunRequested = false;
                zitiBrowzerSwWorkboxCore.dontWaitFor(this.expireEntries());
            }
        }
        /**
         * Update the timestamp for the given URL. This ensures the when
         * removing entries based on maximum entries, most recently used
         * is accurate or when expiring, the timestamp is up-to-date.
         *
         * @param {string} url
         */
        async updateTimestamp(url) {
            await this._timestampModel.setTimestamp(url, Date.now());
        }
        /**
         * Can be used to check if a URL has expired or not before it's used.
         *
         * This requires a look up from IndexedDB, so can be slow.
         *
         * Note: This method will not remove the cached entry, call
         * `expireEntries()` to remove indexedDB and Cache entries.
         *
         * @param {string} url
         * @return {boolean}
         */
        async isURLExpired(url) {
            if (!this._maxAgeSeconds) {
                return false;
            }
            else {
                const timestamp = await this._timestampModel.getTimestamp(url);
                const expireOlderThan = Date.now() - this._maxAgeSeconds * 1000;
                return timestamp !== undefined ? timestamp < expireOlderThan : true;
            }
        }
        /**
         * Removes the IndexedDB object store used to keep track of cache expiration
         * metadata.
         */
        async delete() {
            // Make sure we don't attempt another rerun if we're called in the middle of
            // a cache expiration.
            this._rerunRequested = false;
            await this._timestampModel.expireEntries(Infinity); // Expires all.
        }
    }

    /*
      Copyright 2018 Google LLC

      Use of this source code is governed by an MIT-style
      license that can be found in the LICENSE file or at
      https://opensource.org/licenses/MIT.
    */
    /**
     * This plugin can be used in a `workbox-strategy` to regularly enforce a
     * limit on the age and / or the number of cached requests.
     *
     * It can only be used with `workbox-strategy` instances that have a
     * [custom `cacheName` property set](/web/tools/workbox/guides/configure-workbox#custom_cache_names_in_strategies).
     * In other words, it can't be used to expire entries in strategy that uses the
     * default runtime cache name.
     *
     * Whenever a cached response is used or updated, this plugin will look
     * at the associated cache and remove any old or extra responses.
     *
     * When using `maxAgeSeconds`, responses may be used *once* after expiring
     * because the expiration clean up will not have occurred until *after* the
     * cached response has been used. If the response has a "Date" header, then
     * a light weight expiration check is performed and the response will not be
     * used immediately.
     *
     * When using `maxEntries`, the entry least-recently requested will be removed
     * from the cache first.
     *
     * @memberof workbox-expiration
     */
    class ExpirationPlugin {
        /**
         * @param {ExpirationPluginOptions} config
         * @param {number} [config.maxEntries] The maximum number of entries to cache.
         * Entries used the least will be removed as the maximum is reached.
         * @param {number} [config.maxAgeSeconds] The maximum age of an entry before
         * it's treated as stale and removed.
         * @param {Object} [config.matchOptions] The [`CacheQueryOptions`](https://developer.mozilla.org/en-US/docs/Web/API/Cache/delete#Parameters)
         * that will be used when calling `delete()` on the cache.
         * @param {boolean} [config.purgeOnQuotaError] Whether to opt this cache in to
         * automatic deletion if the available storage quota has been exceeded.
         */
        constructor(config = {}) {
            /**
             * A "lifecycle" callback that will be triggered automatically by the
             * `workbox-strategies` handlers when a `Response` is about to be returned
             * from a [Cache](https://developer.mozilla.org/en-US/docs/Web/API/Cache) to
             * the handler. It allows the `Response` to be inspected for freshness and
             * prevents it from being used if the `Response`'s `Date` header value is
             * older than the configured `maxAgeSeconds`.
             *
             * @param {Object} options
             * @param {string} options.cacheName Name of the cache the response is in.
             * @param {Response} options.cachedResponse The `Response` object that's been
             *     read from a cache and whose freshness should be checked.
             * @return {Response} Either the `cachedResponse`, if it's
             *     fresh, or `null` if the `Response` is older than `maxAgeSeconds`.
             *
             * @private
             */
            this.cachedResponseWillBeUsed = async ({ event, request, cacheName, cachedResponse, }) => {
                if (!cachedResponse) {
                    return null;
                }
                const isFresh = this._isResponseDateFresh(cachedResponse);
                // Expire entries to ensure that even if the expiration date has
                // expired, it'll only be used once.
                const cacheExpiration = this._getCacheExpiration(cacheName);
                zitiBrowzerSwWorkboxCore.dontWaitFor(cacheExpiration.expireEntries());
                // Update the metadata for the request URL to the current timestamp,
                // but don't `await` it as we don't want to block the response.
                const updateTimestampDone = cacheExpiration.updateTimestamp(request.url);
                if (event) {
                    try {
                        event.waitUntil(updateTimestampDone);
                    }
                    catch (error) {
                    }
                }
                return isFresh ? cachedResponse : null;
            };
            /**
             * A "lifecycle" callback that will be triggered automatically by the
             * `workbox-strategies` handlers when an entry is added to a cache.
             *
             * @param {Object} options
             * @param {string} options.cacheName Name of the cache that was updated.
             * @param {string} options.request The Request for the cached entry.
             *
             * @private
             */
            this.cacheDidUpdate = async ({ cacheName, request, }) => {
                const cacheExpiration = this._getCacheExpiration(cacheName);
                await cacheExpiration.updateTimestamp(request.url);
                await cacheExpiration.expireEntries();
            };
            this._config = config;
            this._maxAgeSeconds = config.maxAgeSeconds;
            this._cacheExpirations = new Map();
            if (config.purgeOnQuotaError) {
                zitiBrowzerSwWorkboxCore.registerQuotaErrorCallback(() => this.deleteCacheAndMetadata());
            }
        }
        /**
         * A simple helper method to return a CacheExpiration instance for a given
         * cache name.
         *
         * @param {string} cacheName
         * @return {CacheExpiration}
         *
         * @private
         */
        _getCacheExpiration(cacheName) {
            if (cacheName === zitiBrowzerSwWorkboxCore.cacheNames.getRuntimeName()) {
                throw new zitiBrowzerSwWorkboxCore.WorkboxError$1('expire-custom-caches-only');
            }
            let cacheExpiration = this._cacheExpirations.get(cacheName);
            if (!cacheExpiration) {
                cacheExpiration = new CacheExpiration(cacheName, this._config);
                this._cacheExpirations.set(cacheName, cacheExpiration);
            }
            return cacheExpiration;
        }
        /**
         * @param {Response} cachedResponse
         * @return {boolean}
         *
         * @private
         */
        _isResponseDateFresh(cachedResponse) {
            if (!this._maxAgeSeconds) {
                // We aren't expiring by age, so return true, it's fresh
                return true;
            }
            // Check if the 'date' header will suffice a quick expiration check.
            // See https://github.com/GoogleChromeLabs/sw-toolbox/issues/164 for
            // discussion.
            const dateHeaderTimestamp = this._getDateHeaderTimestamp(cachedResponse);
            if (dateHeaderTimestamp === null) {
                // Unable to parse date, so assume it's fresh.
                return true;
            }
            // If we have a valid headerTime, then our response is fresh iff the
            // headerTime plus maxAgeSeconds is greater than the current time.
            const now = Date.now();
            return dateHeaderTimestamp >= now - this._maxAgeSeconds * 1000;
        }
        /**
         * This method will extract the data header and parse it into a useful
         * value.
         *
         * @param {Response} cachedResponse
         * @return {number|null}
         *
         * @private
         */
        _getDateHeaderTimestamp(cachedResponse) {
            if (!cachedResponse.headers.has('date')) {
                return null;
            }
            const dateHeader = cachedResponse.headers.get('date');
            const parsedDate = new Date(dateHeader);
            const headerTime = parsedDate.getTime();
            // If the Date header was invalid for some reason, parsedDate.getTime()
            // will return NaN.
            if (isNaN(headerTime)) {
                return null;
            }
            return headerTime;
        }
        /**
         * This is a helper method that performs two operations:
         *
         * - Deletes *all* the underlying Cache instances associated with this plugin
         * instance, by calling caches.delete() on your behalf.
         * - Deletes the metadata from IndexedDB used to keep track of expiration
         * details for each Cache instance.
         *
         * When using cache expiration, calling this method is preferable to calling
         * `caches.delete()` directly, since this will ensure that the IndexedDB
         * metadata is also cleanly removed and open IndexedDB instances are deleted.
         *
         * Note that if you're *not* using cache expiration for a given cache, calling
         * `caches.delete()` and passing in the cache's name should be sufficient.
         * There is no Workbox-specific method needed for cleanup in that case.
         */
        async deleteCacheAndMetadata() {
            // Do this one at a time instead of all at once via `Promise.all()` to
            // reduce the chance of inconsistency if a promise rejects.
            for (const [cacheName, cacheExpiration] of this._cacheExpirations) {
                await self.caches.delete(cacheName);
                await cacheExpiration.delete();
            }
            // Reset this._cacheExpirations to its initial state.
            this._cacheExpirations = new Map();
        }
    }

    exports.ExpirationPlugin = ExpirationPlugin;

}));
