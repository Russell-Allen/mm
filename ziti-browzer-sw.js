/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// If the loader is already loaded, just stop.
if (!self.define) {
  let registry = {};

  // Used for `eval` and `importScripts` where we can't get script URL by other means.
  // In both cases, it's safe to use a global var because those functions are synchronous.
  let nextDefineUri;

  const singleRequire = (uri, parentUri) => {
    uri = new URL(uri + ".js", parentUri).href;
    return registry[uri] || (
      
        new Promise(resolve => {
          if ("document" in self) {
            const script = document.createElement("script");
            script.src = uri;
            script.onload = resolve;
            document.head.appendChild(script);
          } else {
            nextDefineUri = uri;
            importScripts(uri);
            resolve();
          }
        })
      
      .then(() => {
        let promise = registry[uri];
        if (!promise) {
          throw new Error(`Module ${uri} didn’t register its module`);
        }
        return promise;
      })
    );
  };

  self.define = (depsNames, factory) => {
    const uri = nextDefineUri || ("document" in self ? document.currentScript.src : "") || location.href;
    if (registry[uri]) {
      // Module is already loading or loaded.
      return;
    }
    let exports = {};
    const require = depUri => singleRequire(depUri, uri);
    const specialDeps = {
      module: { uri },
      exports,
      require
    };
    registry[uri] = Promise.all(depsNames.map(
      depName => specialDeps[depName] || require(depName)
    )).then(deps => {
      factory(...deps);
      return exports;
    });
  };
}
define(['./ziti-browzer-sw-workbox-core-12558fbc', './ziti-browzer-sw-misc-c8698879', './ziti-browzer-sw-workbox-expiration-5e5102c8', './ziti-browzer-sw--workbox-routing--76351553', './ziti-browzer-sw--ziti-browzer-sw-workbox-strategies--e510e42c', './ziti-browzer-sw-uuid-d82426e5', './ziti-browzer-sw-workbox-strategies-2bfa94f1', './ziti-browzer-sw--lodash-es--5f72a803'], (function (zitiBrowzerSwWorkboxCore, zitiBrowzerSwMisc, zitiBrowzerSwWorkboxExpiration, zitiBrowzerSw_WorkboxRouting_, zitiBrowzerSw_ZitiBrowzerSwWorkboxStrategies_, zitiBrowzerSwUuid, zitiBrowzerSwWorkboxStrategies, zitiBrowzerSw_LodashEs_) { 'use strict';

  var name = "@openziti/ziti-browzer-sw";
  var version = "0.20.0";
  var files = [
  	"dist"
  ];
  var main = "dist/ziti-browzer-sw.js";
  var description = "Service Worker used as part of the OpenZiti browZer stack";
  var engines = {
  	node: ">= 10.0.0"
  };
  var devDependencies = {
  	"@rollup/plugin-commonjs": "^22.0.0",
  	"@rollup/plugin-json": "^4.1.0",
  	"@rollup/plugin-node-resolve": "^13.2.1",
  	"@rollup/plugin-replace": "^2.3.4",
  	"@rollup/plugin-typescript": "^8.3.1",
  	"@surma/rollup-plugin-off-main-thread": "^2.2.3",
  	"@types/uuid": "^8.3.4",
  	fsbin: "^1.0.11",
  	"npm-run-all": "^4.1.5",
  	rimraf: "^3.0.2",
  	rollup: "^2.71.1",
  	"rollup-plugin-terser": "^7.0.2",
  	tslib: "^2.3.1",
  	typescript: "^4.6.2",
  	"urlpattern-polyfill": "^0.1.6"
  };
  var scripts = {
  	build: "run-s clean bundle-sw",
  	"bundle-sw": "rollup -c",
  	clean: "rimraf dist",
  	preinstall: "node -e \"if(process.env.npm_execpath.indexOf('yarn') === -1) throw new Error('You must use Yarn to install, not NPM')\""
  };
  var dependencies = {
  	"@openziti/ziti-browzer-sw-workbox-strategies": "^0.23.0",
  	"@types/lodash-es": "^4.17.6",
  	"workbox-core": "^6.5.3",
  	"workbox-expiration": "^6.5.0",
  	"workbox-precaching": "^6.5.0",
  	"workbox-routing": "^6.5.3",
  	"workbox-strategies": "^6.5.3"
  };
  var keywords = [
  	"ziti",
  	"zero trust",
  	"zero-trust",
  	"browZer",
  	"browser",
  	"js",
  	"javascript",
  	"workbox"
  ];
  var repository = {
  	type: "git",
  	url: "https://github.com/openziti/ziti-browzer-sw.git"
  };
  var author = {
  	name: "NetFoundry",
  	url: "http://netfoundry.io",
  	email: "openziti@netfoundry.io"
  };
  var license = "Apache-2.0";
  var bugs = {
  	url: "https://github.com/openziti/ziti-browzer-sw/issues"
  };
  var homepage = "https://github.com/openziti/ziti-browzer-sw";
  var pjson = {
  	name: name,
  	version: version,
  	files: files,
  	main: main,
  	description: description,
  	engines: engines,
  	devDependencies: devDependencies,
  	scripts: scripts,
  	dependencies: dependencies,
  	keywords: keywords,
  	repository: repository,
  	author: author,
  	license: license,
  	bugs: bugs,
  	homepage: homepage
  };

  /**
   *
   */
  self._uuid = zitiBrowzerSwUuid.v4();
  self._core = new zitiBrowzerSw_ZitiBrowzerSwWorkboxStrategies_.ZitiBrowzerCore({});
  self._logger = self._core.createZitiLogger({
      logLevel: self._logLevel,
      suffix: 'SW'
  });
  self._cookieObject = {};
  self._logger.trace(`main sw starting for UUID: `, self._uuid);
  let zfs = new zitiBrowzerSw_ZitiBrowzerSwWorkboxStrategies_.ZitiFirstStrategy({
      uuid: self._uuid,
      zitiBrowzerServiceWorkerGlobalScope: self,
      logLevel: new URLSearchParams(location.search).get("logLevel") || 'Silent',
      controllerApi: new URLSearchParams(location.search).get("controllerApi") || undefined,
      cacheName: 'ziti-browzer-cache',
      plugins: [
          new zitiBrowzerSwWorkboxExpiration.ExpirationPlugin({
              // Cap the number of items we cache
              maxEntries: 1000,
              // Don't keep any items for more than 30 days
              maxAgeSeconds: 30 * 24 * 60 * 60,
              // Automatically cleanup if cache quota is exceeded
              purgeOnQuotaError: false
          }),
          {
              fetchDidFail: async ({ originalRequest, request, error, event, state }) => {
                  // No return expected.
                  // Note: `originalRequest` is the browser's request, `request` is the
                  // request after being passed through plugins with
                  // `requestWillFetch` callbacks, and `error` is the exception that caused
                  // the underlying `fetch()` to fail.
              },
          },
      ],
  });
  const matchGETCb = (url, request) => {
      if (typeof self._zitiConfig === 'undefined') {
          return true;
      }
      let getURL = new URL(url);
      if (getURL.search.includes("code=") && getURL.search.includes("state=")) {
          return false;
      }
      let controllerURL = new URL(self._zitiConfig.controller.api);
      if (url.hostname === controllerURL.hostname) {
          return false;
      }
      else {
          return true;
      }
  };
  zitiBrowzerSw_WorkboxRouting_.registerRoute(({ url, request }) => matchGETCb(url), zfs, 'GET');
  const matchPOSTCb = (url, request) => {
      if (typeof self._zitiConfig === 'undefined') {
          return false;
      }
      if (url.hostname === self._zitiConfig.httpAgent.self.host) {
          return true;
      }
      else {
          return false;
      }
  };
  zitiBrowzerSw_WorkboxRouting_.registerRoute(({ url, request }) => matchPOSTCb(url), zfs, 'POST');
  zitiBrowzerSwWorkboxCore.clientsClaim();
  /**
   *
   */
  self.addEventListener('message', async (event) => {
      /**
       *
       */
      if (event.data.type === 'GET_VERSION') {
          self._logger.trace(`message.GET_VERSION received`);
          event.ports[0].postMessage({
              version: pjson.version,
              zitiConfig: self._zitiConfig
          });
      }
      /**
       *
       */
      else if (event.data.type === 'SET_CONFIG') {
          self._logger.trace(`message.SET_CONFIG received, payload is: `, event.data.payload);
          self._zitiConfig = event.data.payload.zitiConfig;
          self._logger.trace(`message.SET_CONFIG set for UUID: `, self._uuid);
          event.ports[0].postMessage({
              version: pjson.version,
              zitiConfig: self._zitiConfig
          });
      }
      /**
       *
       */
      else if (event.data.type === 'SET_COOKIE') {
          self._logger.trace(`message.SET_COOKIE received, payload is: `, event.data.payload);
          let name = event.data.payload.name;
          let value = event.data.payload.value;
          if (typeof self._cookieObject !== 'undefined') {
              self._cookieObject[name] = value;
              self._logger.trace(`_cookieObject: `, self._cookieObject);
          }
      }
      /**
       *
       */
      else if (event.data.type === 'ZBR_INIT_COMPLETE') {
          self._logger.trace(`message.ZBR_INIT_COMPLETE received, payload is: `, event.data.payload);
          self._zbrReloadPending = false;
          self._zitiConfig = event.data.payload.zitiConfig;
          self._zbrPingTimestamp = Date.now();
      }
      /**
       *
       */
      else if (event.data.type === 'ZBR_PING') {
          self._zbrPingTimestamp = event.data.payload.timestamp;
      }
      /**
       *
       */
      else if (event.data.type === 'UNREGISTER') {
          self._logger.trace(`message.UNREGISTER received `);
          self.registration.unregister();
          const windows = await self.clients.matchAll({ type: 'window' });
          for (const window of windows) {
              window.postMessage({
                  type: 'RELOAD'
              });
          }
      }
      /**
       *
       */
      else {
          self._logger.error(`message.<UNKNOWN> received [${event.data.type}]`);
      }
  });
  /**
   *
   */
  self._unregister = async function () {
      self._logger.trace(`_unregister starting `);
      self.registration.unregister();
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const window of windows) {
          window.postMessage({
              type: 'RELOAD'
          });
      }
      self._logger.trace(`_unregister completed `);
  };
  /**
   *
   */
  self._pingPage = async function () {
      self._logger.trace(`_pingPage starting `);
      self.registration.unregister();
      const windows = await self.clients.matchAll({ type: 'window' });
      return new Promise(async function (resolve, reject) {
          for (const window of windows) {
              var messageChannel = new MessageChannel();
              messageChannel.port1.onmessage = function (event) {
                  self._logger.trace('_pingPage() <-- reply received');
                  resolve('ok');
              };
              window.postMessage({
                  type: 'PING',
              }, [messageChannel.port2]);
          }
          self._logger.trace(`_pingPage() --> sent `);
      });
  };
  /**
   *
   */
  self._sendMessageToClients = async function (message) {
      const allClients = await self.clients.matchAll({ type: 'window' });
      return new Promise(async function (resolve, reject) {
          for (const client of allClients) {
              self._logger.trace('sendMessageToClients() processing cmd: ', message.type);
              var messageChannel = new MessageChannel();
              messageChannel.port1.onmessage = function (event) {
                  self._logger.trace('ziti-sw: sendMessageToClient() reply event is: ', message.type, ' - ', event.data.response);
                  if (event.data.error) {
                      reject(event.data.error);
                  }
                  else {
                      resolve(event.data.response);
                  }
              };
              client.postMessage(message, [messageChannel.port2]);
          }
      });
  };

}));
