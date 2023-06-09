define(['exports'], (function (exports) { 'use strict';

    const instanceOfAny = (object, constructors) => constructors.some((c) => object instanceof c);

    let idbProxyableTypes;
    let cursorAdvanceMethods;
    // This is a function to prevent it throwing up in node environments.
    function getIdbProxyableTypes() {
        return (idbProxyableTypes ||
            (idbProxyableTypes = [
                IDBDatabase,
                IDBObjectStore,
                IDBIndex,
                IDBCursor,
                IDBTransaction,
            ]));
    }
    // This is a function to prevent it throwing up in node environments.
    function getCursorAdvanceMethods() {
        return (cursorAdvanceMethods ||
            (cursorAdvanceMethods = [
                IDBCursor.prototype.advance,
                IDBCursor.prototype.continue,
                IDBCursor.prototype.continuePrimaryKey,
            ]));
    }
    const cursorRequestMap = new WeakMap();
    const transactionDoneMap = new WeakMap();
    const transactionStoreNamesMap = new WeakMap();
    const transformCache = new WeakMap();
    const reverseTransformCache = new WeakMap();
    function promisifyRequest(request) {
        const promise = new Promise((resolve, reject) => {
            const unlisten = () => {
                request.removeEventListener('success', success);
                request.removeEventListener('error', error);
            };
            const success = () => {
                resolve(wrap$1(request.result));
                unlisten();
            };
            const error = () => {
                reject(request.error);
                unlisten();
            };
            request.addEventListener('success', success);
            request.addEventListener('error', error);
        });
        promise
            .then((value) => {
            // Since cursoring reuses the IDBRequest (*sigh*), we cache it for later retrieval
            // (see wrapFunction).
            if (value instanceof IDBCursor) {
                cursorRequestMap.set(value, request);
            }
            // Catching to avoid "Uncaught Promise exceptions"
        })
            .catch(() => { });
        // This mapping exists in reverseTransformCache but doesn't doesn't exist in transformCache. This
        // is because we create many promises from a single IDBRequest.
        reverseTransformCache.set(promise, request);
        return promise;
    }
    function cacheDonePromiseForTransaction(tx) {
        // Early bail if we've already created a done promise for this transaction.
        if (transactionDoneMap.has(tx))
            return;
        const done = new Promise((resolve, reject) => {
            const unlisten = () => {
                tx.removeEventListener('complete', complete);
                tx.removeEventListener('error', error);
                tx.removeEventListener('abort', error);
            };
            const complete = () => {
                resolve();
                unlisten();
            };
            const error = () => {
                reject(tx.error || new DOMException('AbortError', 'AbortError'));
                unlisten();
            };
            tx.addEventListener('complete', complete);
            tx.addEventListener('error', error);
            tx.addEventListener('abort', error);
        });
        // Cache it for later retrieval.
        transactionDoneMap.set(tx, done);
    }
    let idbProxyTraps = {
        get(target, prop, receiver) {
            if (target instanceof IDBTransaction) {
                // Special handling for transaction.done.
                if (prop === 'done')
                    return transactionDoneMap.get(target);
                // Polyfill for objectStoreNames because of Edge.
                if (prop === 'objectStoreNames') {
                    return target.objectStoreNames || transactionStoreNamesMap.get(target);
                }
                // Make tx.store return the only store in the transaction, or undefined if there are many.
                if (prop === 'store') {
                    return receiver.objectStoreNames[1]
                        ? undefined
                        : receiver.objectStore(receiver.objectStoreNames[0]);
                }
            }
            // Else transform whatever we get back.
            return wrap$1(target[prop]);
        },
        set(target, prop, value) {
            target[prop] = value;
            return true;
        },
        has(target, prop) {
            if (target instanceof IDBTransaction &&
                (prop === 'done' || prop === 'store')) {
                return true;
            }
            return prop in target;
        },
    };
    function replaceTraps(callback) {
        idbProxyTraps = callback(idbProxyTraps);
    }
    function wrapFunction(func) {
        // Due to expected object equality (which is enforced by the caching in `wrap`), we
        // only create one new func per func.
        // Edge doesn't support objectStoreNames (booo), so we polyfill it here.
        if (func === IDBDatabase.prototype.transaction &&
            !('objectStoreNames' in IDBTransaction.prototype)) {
            return function (storeNames, ...args) {
                const tx = func.call(unwrap$1(this), storeNames, ...args);
                transactionStoreNamesMap.set(tx, storeNames.sort ? storeNames.sort() : [storeNames]);
                return wrap$1(tx);
            };
        }
        // Cursor methods are special, as the behaviour is a little more different to standard IDB. In
        // IDB, you advance the cursor and wait for a new 'success' on the IDBRequest that gave you the
        // cursor. It's kinda like a promise that can resolve with many values. That doesn't make sense
        // with real promises, so each advance methods returns a new promise for the cursor object, or
        // undefined if the end of the cursor has been reached.
        if (getCursorAdvanceMethods().includes(func)) {
            return function (...args) {
                // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
                // the original object.
                func.apply(unwrap$1(this), args);
                return wrap$1(cursorRequestMap.get(this));
            };
        }
        return function (...args) {
            // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
            // the original object.
            return wrap$1(func.apply(unwrap$1(this), args));
        };
    }
    function transformCachableValue(value) {
        if (typeof value === 'function')
            return wrapFunction(value);
        // This doesn't return, it just creates a 'done' promise for the transaction,
        // which is later returned for transaction.done (see idbObjectHandler).
        if (value instanceof IDBTransaction)
            cacheDonePromiseForTransaction(value);
        if (instanceOfAny(value, getIdbProxyableTypes()))
            return new Proxy(value, idbProxyTraps);
        // Return the same value back if we're not going to transform it.
        return value;
    }
    function wrap$1(value) {
        // We sometimes generate multiple promises from a single IDBRequest (eg when cursoring), because
        // IDB is weird and a single IDBRequest can yield many responses, so these can't be cached.
        if (value instanceof IDBRequest)
            return promisifyRequest(value);
        // If we've already transformed this value before, reuse the transformed value.
        // This is faster, but it also provides object equality.
        if (transformCache.has(value))
            return transformCache.get(value);
        const newValue = transformCachableValue(value);
        // Not all types are transformed.
        // These may be primitive types, so they can't be WeakMap keys.
        if (newValue !== value) {
            transformCache.set(value, newValue);
            reverseTransformCache.set(newValue, value);
        }
        return newValue;
    }
    const unwrap$1 = (value) => reverseTransformCache.get(value);

    /**
     * Open a database.
     *
     * @param name Name of the database.
     * @param version Schema version.
     * @param callbacks Additional callbacks.
     */
    function openDB(name, version, { blocked, upgrade, blocking, terminated } = {}) {
        const request = indexedDB.open(name, version);
        const openPromise = wrap$1(request);
        if (upgrade) {
            request.addEventListener('upgradeneeded', (event) => {
                upgrade(wrap$1(request.result), event.oldVersion, event.newVersion, wrap$1(request.transaction));
            });
        }
        if (blocked)
            request.addEventListener('blocked', () => blocked());
        openPromise
            .then((db) => {
            if (terminated)
                db.addEventListener('close', () => terminated());
            if (blocking)
                db.addEventListener('versionchange', () => blocking());
        })
            .catch(() => { });
        return openPromise;
    }
    /**
     * Delete a database.
     *
     * @param name Name of the database.
     */
    function deleteDB(name, { blocked } = {}) {
        const request = indexedDB.deleteDatabase(name);
        if (blocked)
            request.addEventListener('blocked', () => blocked());
        return wrap$1(request).then(() => undefined);
    }

    const readMethods = ['get', 'getKey', 'getAll', 'getAllKeys', 'count'];
    const writeMethods = ['put', 'add', 'delete', 'clear'];
    const cachedMethods = new Map();
    function getMethod(target, prop) {
        if (!(target instanceof IDBDatabase &&
            !(prop in target) &&
            typeof prop === 'string')) {
            return;
        }
        if (cachedMethods.get(prop))
            return cachedMethods.get(prop);
        const targetFuncName = prop.replace(/FromIndex$/, '');
        const useIndex = prop !== targetFuncName;
        const isWrite = writeMethods.includes(targetFuncName);
        if (
        // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
        !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) ||
            !(isWrite || readMethods.includes(targetFuncName))) {
            return;
        }
        const method = async function (storeName, ...args) {
            // isWrite ? 'readwrite' : undefined gzipps better, but fails in Edge :(
            const tx = this.transaction(storeName, isWrite ? 'readwrite' : 'readonly');
            let target = tx.store;
            if (useIndex)
                target = target.index(args.shift());
            // Must reject if op rejects.
            // If it's a write operation, must reject if tx.done rejects.
            // Must reject with op rejection first.
            // Must resolve with op value.
            // Must handle both promises (no unhandled rejections)
            return (await Promise.all([
                target[targetFuncName](...args),
                isWrite && tx.done,
            ]))[0];
        };
        cachedMethods.set(prop, method);
        return method;
    }
    replaceTraps((oldTraps) => ({
        ...oldTraps,
        get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
        has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop),
    }));

    const E_CANCELED = new Error('request for lock canceled');

    var __awaiter$2 = function (thisArg, _arguments, P, generator) {
        function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
        return new (P || (P = Promise))(function (resolve, reject) {
            function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
            function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
            function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
            step((generator = generator.apply(thisArg, _arguments || [])).next());
        });
    };
    class Semaphore {
        constructor(_maxConcurrency, _cancelError = E_CANCELED) {
            this._maxConcurrency = _maxConcurrency;
            this._cancelError = _cancelError;
            this._queue = [];
            this._waiters = [];
            if (_maxConcurrency <= 0) {
                throw new Error('semaphore must be initialized to a positive value');
            }
            this._value = _maxConcurrency;
        }
        acquire() {
            const locked = this.isLocked();
            const ticketPromise = new Promise((resolve, reject) => this._queue.push({ resolve, reject }));
            if (!locked)
                this._dispatch();
            return ticketPromise;
        }
        runExclusive(callback) {
            return __awaiter$2(this, void 0, void 0, function* () {
                const [value, release] = yield this.acquire();
                try {
                    return yield callback(value);
                }
                finally {
                    release();
                }
            });
        }
        waitForUnlock() {
            return __awaiter$2(this, void 0, void 0, function* () {
                if (!this.isLocked()) {
                    return Promise.resolve();
                }
                const waitPromise = new Promise((resolve) => this._waiters.push({ resolve }));
                return waitPromise;
            });
        }
        isLocked() {
            return this._value <= 0;
        }
        /** @deprecated Deprecated in 0.3.0, will be removed in 0.4.0. Use runExclusive instead. */
        release() {
            if (this._maxConcurrency > 1) {
                throw new Error('this method is unavailable on semaphores with concurrency > 1; use the scoped release returned by acquire instead');
            }
            if (this._currentReleaser) {
                const releaser = this._currentReleaser;
                this._currentReleaser = undefined;
                releaser();
            }
        }
        cancel() {
            this._queue.forEach((ticket) => ticket.reject(this._cancelError));
            this._queue = [];
        }
        _dispatch() {
            const nextTicket = this._queue.shift();
            if (!nextTicket)
                return;
            let released = false;
            this._currentReleaser = () => {
                if (released)
                    return;
                released = true;
                this._value++;
                this._resolveWaiters();
                this._dispatch();
            };
            nextTicket.resolve([this._value--, this._currentReleaser]);
        }
        _resolveWaiters() {
            this._waiters.forEach((waiter) => waiter.resolve());
            this._waiters = [];
        }
    }

    var __awaiter$1 = function (thisArg, _arguments, P, generator) {
        function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
        return new (P || (P = Promise))(function (resolve, reject) {
            function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
            function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
            function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
            step((generator = generator.apply(thisArg, _arguments || [])).next());
        });
    };
    class Mutex {
        constructor(cancelError) {
            this._semaphore = new Semaphore(1, cancelError);
        }
        acquire() {
            return __awaiter$1(this, void 0, void 0, function* () {
                const [, releaser] = yield this._semaphore.acquire();
                return releaser;
            });
        }
        runExclusive(callback) {
            return this._semaphore.runExclusive(() => callback());
        }
        isLocked() {
            return this._semaphore.isLocked();
        }
        waitForUnlock() {
            return this._semaphore.waitForUnlock();
        }
        /** @deprecated Deprecated in 0.3.0, will be removed in 0.4.0. Use runExclusive instead. */
        release() {
            this._semaphore.release();
        }
        cancel() {
            return this._semaphore.cancel();
        }
    }

    const defaultOpts$2 = {
        xml: false,
        decodeEntities: true,
    };
    const xmlModeDefault = {
        _useHtmlParser2: true,
        xmlMode: true,
    };
    /**
     * Flatten the options for Cheerio.
     *
     * This will set `_useHtmlParser2` to true if `xml` is set to true.
     *
     * @param options - The options to flatten.
     * @returns The flattened options.
     */
    function flatten(options) {
        return (options === null || options === void 0 ? void 0 : options.xml)
            ? typeof options.xml === 'boolean'
                ? xmlModeDefault
                : { ...xmlModeDefault, ...options.xml }
            : options !== null && options !== void 0 ? options : undefined;
    }

    /** Types of elements found in htmlparser2's DOM */
    var ElementType;
    (function (ElementType) {
        /** Type for the root element of a document */
        ElementType["Root"] = "root";
        /** Type for Text */
        ElementType["Text"] = "text";
        /** Type for <? ... ?> */
        ElementType["Directive"] = "directive";
        /** Type for <!-- ... --> */
        ElementType["Comment"] = "comment";
        /** Type for <script> tags */
        ElementType["Script"] = "script";
        /** Type for <style> tags */
        ElementType["Style"] = "style";
        /** Type for Any tag */
        ElementType["Tag"] = "tag";
        /** Type for <![CDATA[ ... ]]> */
        ElementType["CDATA"] = "cdata";
        /** Type for <!doctype ...> */
        ElementType["Doctype"] = "doctype";
    })(ElementType || (ElementType = {}));
    /**
     * Tests whether an element is a tag or not.
     *
     * @param elem Element to test
     */
    function isTag$1(elem) {
        return (elem.type === ElementType.Tag ||
            elem.type === ElementType.Script ||
            elem.type === ElementType.Style);
    }
    // Exports for backwards compatibility
    /** Type for the root element of a document */
    const Root = ElementType.Root;
    /** Type for Text */
    const Text$1 = ElementType.Text;
    /** Type for <? ... ?> */
    const Directive = ElementType.Directive;
    /** Type for <!-- ... --> */
    const Comment$1 = ElementType.Comment;
    /** Type for <script> tags */
    const Script = ElementType.Script;
    /** Type for <style> tags */
    const Style = ElementType.Style;
    /** Type for Any tag */
    const Tag = ElementType.Tag;
    /** Type for <![CDATA[ ... ]]> */
    const CDATA$1 = ElementType.CDATA;
    /** Type for <!doctype ...> */
    const Doctype = ElementType.Doctype;

    /**
     * This object will be used as the prototype for Nodes when creating a
     * DOM-Level-1-compliant structure.
     */
    class Node {
        constructor() {
            /** Parent of the node */
            this.parent = null;
            /** Previous sibling */
            this.prev = null;
            /** Next sibling */
            this.next = null;
            /** The start index of the node. Requires `withStartIndices` on the handler to be `true. */
            this.startIndex = null;
            /** The end index of the node. Requires `withEndIndices` on the handler to be `true. */
            this.endIndex = null;
        }
        // Read-write aliases for properties
        /**
         * Same as {@link parent}.
         * [DOM spec](https://dom.spec.whatwg.org)-compatible alias.
         */
        get parentNode() {
            return this.parent;
        }
        set parentNode(parent) {
            this.parent = parent;
        }
        /**
         * Same as {@link prev}.
         * [DOM spec](https://dom.spec.whatwg.org)-compatible alias.
         */
        get previousSibling() {
            return this.prev;
        }
        set previousSibling(prev) {
            this.prev = prev;
        }
        /**
         * Same as {@link next}.
         * [DOM spec](https://dom.spec.whatwg.org)-compatible alias.
         */
        get nextSibling() {
            return this.next;
        }
        set nextSibling(next) {
            this.next = next;
        }
        /**
         * Clone this node, and optionally its children.
         *
         * @param recursive Clone child nodes as well.
         * @returns A clone of the node.
         */
        cloneNode(recursive = false) {
            return cloneNode(this, recursive);
        }
    }
    /**
     * A node that contains some data.
     */
    class DataNode extends Node {
        /**
         * @param data The content of the data node
         */
        constructor(data) {
            super();
            this.data = data;
        }
        /**
         * Same as {@link data}.
         * [DOM spec](https://dom.spec.whatwg.org)-compatible alias.
         */
        get nodeValue() {
            return this.data;
        }
        set nodeValue(data) {
            this.data = data;
        }
    }
    /**
     * Text within the document.
     */
    class Text extends DataNode {
        constructor() {
            super(...arguments);
            this.type = ElementType.Text;
        }
        get nodeType() {
            return 3;
        }
    }
    /**
     * Comments within the document.
     */
    class Comment extends DataNode {
        constructor() {
            super(...arguments);
            this.type = ElementType.Comment;
        }
        get nodeType() {
            return 8;
        }
    }
    /**
     * Processing instructions, including doc types.
     */
    class ProcessingInstruction extends DataNode {
        constructor(name, data) {
            super(data);
            this.name = name;
            this.type = ElementType.Directive;
        }
        get nodeType() {
            return 1;
        }
    }
    /**
     * A `Node` that can have children.
     */
    class NodeWithChildren extends Node {
        /**
         * @param children Children of the node. Only certain node types can have children.
         */
        constructor(children) {
            super();
            this.children = children;
        }
        // Aliases
        /** First child of the node. */
        get firstChild() {
            var _a;
            return (_a = this.children[0]) !== null && _a !== void 0 ? _a : null;
        }
        /** Last child of the node. */
        get lastChild() {
            return this.children.length > 0
                ? this.children[this.children.length - 1]
                : null;
        }
        /**
         * Same as {@link children}.
         * [DOM spec](https://dom.spec.whatwg.org)-compatible alias.
         */
        get childNodes() {
            return this.children;
        }
        set childNodes(children) {
            this.children = children;
        }
    }
    class CDATA extends NodeWithChildren {
        constructor() {
            super(...arguments);
            this.type = ElementType.CDATA;
        }
        get nodeType() {
            return 4;
        }
    }
    /**
     * The root node of the document.
     */
    class Document extends NodeWithChildren {
        constructor() {
            super(...arguments);
            this.type = ElementType.Root;
        }
        get nodeType() {
            return 9;
        }
    }
    /**
     * An element within the DOM.
     */
    class Element extends NodeWithChildren {
        /**
         * @param name Name of the tag, eg. `div`, `span`.
         * @param attribs Object mapping attribute names to attribute values.
         * @param children Children of the node.
         */
        constructor(name, attribs, children = [], type = name === "script"
            ? ElementType.Script
            : name === "style"
                ? ElementType.Style
                : ElementType.Tag) {
            super(children);
            this.name = name;
            this.attribs = attribs;
            this.type = type;
        }
        get nodeType() {
            return 1;
        }
        // DOM Level 1 aliases
        /**
         * Same as {@link name}.
         * [DOM spec](https://dom.spec.whatwg.org)-compatible alias.
         */
        get tagName() {
            return this.name;
        }
        set tagName(name) {
            this.name = name;
        }
        get attributes() {
            return Object.keys(this.attribs).map((name) => {
                var _a, _b;
                return ({
                    name,
                    value: this.attribs[name],
                    namespace: (_a = this["x-attribsNamespace"]) === null || _a === void 0 ? void 0 : _a[name],
                    prefix: (_b = this["x-attribsPrefix"]) === null || _b === void 0 ? void 0 : _b[name],
                });
            });
        }
    }
    /**
     * @param node Node to check.
     * @returns `true` if the node is a `Element`, `false` otherwise.
     */
    function isTag(node) {
        return isTag$1(node);
    }
    /**
     * @param node Node to check.
     * @returns `true` if the node has the type `CDATA`, `false` otherwise.
     */
    function isCDATA(node) {
        return node.type === ElementType.CDATA;
    }
    /**
     * @param node Node to check.
     * @returns `true` if the node has the type `Text`, `false` otherwise.
     */
    function isText(node) {
        return node.type === ElementType.Text;
    }
    /**
     * @param node Node to check.
     * @returns `true` if the node has the type `Comment`, `false` otherwise.
     */
    function isComment(node) {
        return node.type === ElementType.Comment;
    }
    /**
     * @param node Node to check.
     * @returns `true` if the node has the type `ProcessingInstruction`, `false` otherwise.
     */
    function isDirective(node) {
        return node.type === ElementType.Directive;
    }
    /**
     * @param node Node to check.
     * @returns `true` if the node has the type `ProcessingInstruction`, `false` otherwise.
     */
    function isDocument(node) {
        return node.type === ElementType.Root;
    }
    /**
     * @param node Node to check.
     * @returns `true` if the node has children, `false` otherwise.
     */
    function hasChildren(node) {
        return Object.prototype.hasOwnProperty.call(node, "children");
    }
    /**
     * Clone a node, and optionally its children.
     *
     * @param recursive Clone child nodes as well.
     * @returns A clone of the node.
     */
    function cloneNode(node, recursive = false) {
        let result;
        if (isText(node)) {
            result = new Text(node.data);
        }
        else if (isComment(node)) {
            result = new Comment(node.data);
        }
        else if (isTag(node)) {
            const children = recursive ? cloneChildren(node.children) : [];
            const clone = new Element(node.name, { ...node.attribs }, children);
            children.forEach((child) => (child.parent = clone));
            if (node.namespace != null) {
                clone.namespace = node.namespace;
            }
            if (node["x-attribsNamespace"]) {
                clone["x-attribsNamespace"] = { ...node["x-attribsNamespace"] };
            }
            if (node["x-attribsPrefix"]) {
                clone["x-attribsPrefix"] = { ...node["x-attribsPrefix"] };
            }
            result = clone;
        }
        else if (isCDATA(node)) {
            const children = recursive ? cloneChildren(node.children) : [];
            const clone = new CDATA(children);
            children.forEach((child) => (child.parent = clone));
            result = clone;
        }
        else if (isDocument(node)) {
            const children = recursive ? cloneChildren(node.children) : [];
            const clone = new Document(children);
            children.forEach((child) => (child.parent = clone));
            if (node["x-mode"]) {
                clone["x-mode"] = node["x-mode"];
            }
            result = clone;
        }
        else if (isDirective(node)) {
            const instruction = new ProcessingInstruction(node.name, node.data);
            if (node["x-name"] != null) {
                instruction["x-name"] = node["x-name"];
                instruction["x-publicId"] = node["x-publicId"];
                instruction["x-systemId"] = node["x-systemId"];
            }
            result = instruction;
        }
        else {
            throw new Error(`Not implemented yet: ${node.type}`);
        }
        result.startIndex = node.startIndex;
        result.endIndex = node.endIndex;
        if (node.sourceCodeLocation != null) {
            result.sourceCodeLocation = node.sourceCodeLocation;
        }
        return result;
    }
    function cloneChildren(childs) {
        const children = childs.map((child) => cloneNode(child, true));
        for (let i = 1; i < children.length; i++) {
            children[i].prev = children[i - 1];
            children[i - 1].next = children[i];
        }
        return children;
    }

    // Default options
    const defaultOpts$1 = {
        withStartIndices: false,
        withEndIndices: false,
        xmlMode: false,
    };
    class DomHandler {
        /**
         * @param callback Called once parsing has completed.
         * @param options Settings for the handler.
         * @param elementCB Callback whenever a tag is closed.
         */
        constructor(callback, options, elementCB) {
            /** The elements of the DOM */
            this.dom = [];
            /** The root element for the DOM */
            this.root = new Document(this.dom);
            /** Indicated whether parsing has been completed. */
            this.done = false;
            /** Stack of open tags. */
            this.tagStack = [this.root];
            /** A data node that is still being written to. */
            this.lastNode = null;
            /** Reference to the parser instance. Used for location information. */
            this.parser = null;
            // Make it possible to skip arguments, for backwards-compatibility
            if (typeof options === "function") {
                elementCB = options;
                options = defaultOpts$1;
            }
            if (typeof callback === "object") {
                options = callback;
                callback = undefined;
            }
            this.callback = callback !== null && callback !== void 0 ? callback : null;
            this.options = options !== null && options !== void 0 ? options : defaultOpts$1;
            this.elementCB = elementCB !== null && elementCB !== void 0 ? elementCB : null;
        }
        onparserinit(parser) {
            this.parser = parser;
        }
        // Resets the handler back to starting state
        onreset() {
            this.dom = [];
            this.root = new Document(this.dom);
            this.done = false;
            this.tagStack = [this.root];
            this.lastNode = null;
            this.parser = null;
        }
        // Signals the handler that parsing is done
        onend() {
            if (this.done)
                return;
            this.done = true;
            this.parser = null;
            this.handleCallback(null);
        }
        onerror(error) {
            this.handleCallback(error);
        }
        onclosetag() {
            this.lastNode = null;
            const elem = this.tagStack.pop();
            if (this.options.withEndIndices) {
                elem.endIndex = this.parser.endIndex;
            }
            if (this.elementCB)
                this.elementCB(elem);
        }
        onopentag(name, attribs) {
            const type = this.options.xmlMode ? ElementType.Tag : undefined;
            const element = new Element(name, attribs, undefined, type);
            this.addNode(element);
            this.tagStack.push(element);
        }
        ontext(data) {
            const { lastNode } = this;
            if (lastNode && lastNode.type === ElementType.Text) {
                lastNode.data += data;
                if (this.options.withEndIndices) {
                    lastNode.endIndex = this.parser.endIndex;
                }
            }
            else {
                const node = new Text(data);
                this.addNode(node);
                this.lastNode = node;
            }
        }
        oncomment(data) {
            if (this.lastNode && this.lastNode.type === ElementType.Comment) {
                this.lastNode.data += data;
                return;
            }
            const node = new Comment(data);
            this.addNode(node);
            this.lastNode = node;
        }
        oncommentend() {
            this.lastNode = null;
        }
        oncdatastart() {
            const text = new Text("");
            const node = new CDATA([text]);
            this.addNode(node);
            text.parent = node;
            this.lastNode = text;
        }
        oncdataend() {
            this.lastNode = null;
        }
        onprocessinginstruction(name, data) {
            const node = new ProcessingInstruction(name, data);
            this.addNode(node);
        }
        handleCallback(error) {
            if (typeof this.callback === "function") {
                this.callback(error, this.dom);
            }
            else if (error) {
                throw error;
            }
        }
        addNode(node) {
            const parent = this.tagStack[this.tagStack.length - 1];
            const previousSibling = parent.children[parent.children.length - 1];
            if (this.options.withStartIndices) {
                node.startIndex = this.parser.startIndex;
            }
            if (this.options.withEndIndices) {
                node.endIndex = this.parser.endIndex;
            }
            parent.children.push(node);
            if (previousSibling) {
                node.prev = previousSibling;
                previousSibling.next = node;
            }
            node.parent = parent;
            this.lastNode = null;
        }
    }

    // Generated using scripts/write-decode-map.ts
    // prettier-ignore
    var htmlDecodeTree = new Uint16Array([7489, 60, 213, 305, 650, 1181, 1403, 1488, 1653, 1758, 1954, 2006, 2063, 2634, 2705, 3489, 3693, 3849, 3878, 4298, 4648, 4833, 5141, 5277, 5315, 5343, 5413, 0, 0, 0, 0, 0, 0, 5483, 5837, 6541, 7186, 7645, 8062, 8288, 8624, 8845, 9152, 9211, 9282, 10276, 10514, 11528, 11848, 12238, 12310, 12986, 13881, 14252, 14590, 14888, 14961, 15072, 15150, 2048, 69, 77, 97, 98, 99, 102, 103, 108, 109, 110, 111, 112, 114, 115, 116, 117, 92, 98, 102, 109, 115, 127, 132, 139, 144, 149, 152, 166, 179, 185, 200, 207, 108, 105, 103, 32827, 198, 16582, 80, 32827, 38, 16422, 99, 117, 116, 101, 32827, 193, 16577, 114, 101, 118, 101, 59, 16642, 256, 105, 121, 120, 125, 114, 99, 32827, 194, 16578, 59, 17424, 114, 59, 49152, 55349, 56580, 114, 97, 118, 101, 32827, 192, 16576, 112, 104, 97, 59, 17297, 97, 99, 114, 59, 16640, 100, 59, 27219, 256, 103, 112, 157, 161, 111, 110, 59, 16644, 102, 59, 49152, 55349, 56632, 112, 108, 121, 70, 117, 110, 99, 116, 105, 111, 110, 59, 24673, 105, 110, 103, 32827, 197, 16581, 256, 99, 115, 190, 195, 114, 59, 49152, 55349, 56476, 105, 103, 110, 59, 25172, 105, 108, 100, 101, 32827, 195, 16579, 109, 108, 32827, 196, 16580, 1024, 97, 99, 101, 102, 111, 114, 115, 117, 229, 251, 254, 279, 284, 290, 295, 298, 256, 99, 114, 234, 242, 107, 115, 108, 97, 115, 104, 59, 25110, 374, 246, 248, 59, 27367, 101, 100, 59, 25350, 121, 59, 17425, 384, 99, 114, 116, 261, 267, 276, 97, 117, 115, 101, 59, 25141, 110, 111, 117, 108, 108, 105, 115, 59, 24876, 97, 59, 17298, 114, 59, 49152, 55349, 56581, 112, 102, 59, 49152, 55349, 56633, 101, 118, 101, 59, 17112, 99, 242, 275, 109, 112, 101, 113, 59, 25166, 1792, 72, 79, 97, 99, 100, 101, 102, 104, 105, 108, 111, 114, 115, 117, 333, 337, 342, 384, 414, 418, 437, 439, 442, 476, 533, 627, 632, 638, 99, 121, 59, 17447, 80, 89, 32827, 169, 16553, 384, 99, 112, 121, 349, 354, 378, 117, 116, 101, 59, 16646, 256, 59, 105, 359, 360, 25298, 116, 97, 108, 68, 105, 102, 102, 101, 114, 101, 110, 116, 105, 97, 108, 68, 59, 24901, 108, 101, 121, 115, 59, 24877, 512, 97, 101, 105, 111, 393, 398, 404, 408, 114, 111, 110, 59, 16652, 100, 105, 108, 32827, 199, 16583, 114, 99, 59, 16648, 110, 105, 110, 116, 59, 25136, 111, 116, 59, 16650, 256, 100, 110, 423, 429, 105, 108, 108, 97, 59, 16568, 116, 101, 114, 68, 111, 116, 59, 16567, 242, 383, 105, 59, 17319, 114, 99, 108, 101, 512, 68, 77, 80, 84, 455, 459, 465, 470, 111, 116, 59, 25241, 105, 110, 117, 115, 59, 25238, 108, 117, 115, 59, 25237, 105, 109, 101, 115, 59, 25239, 111, 256, 99, 115, 482, 504, 107, 119, 105, 115, 101, 67, 111, 110, 116, 111, 117, 114, 73, 110, 116, 101, 103, 114, 97, 108, 59, 25138, 101, 67, 117, 114, 108, 121, 256, 68, 81, 515, 527, 111, 117, 98, 108, 101, 81, 117, 111, 116, 101, 59, 24605, 117, 111, 116, 101, 59, 24601, 512, 108, 110, 112, 117, 542, 552, 583, 597, 111, 110, 256, 59, 101, 549, 550, 25143, 59, 27252, 384, 103, 105, 116, 559, 566, 570, 114, 117, 101, 110, 116, 59, 25185, 110, 116, 59, 25135, 111, 117, 114, 73, 110, 116, 101, 103, 114, 97, 108, 59, 25134, 256, 102, 114, 588, 590, 59, 24834, 111, 100, 117, 99, 116, 59, 25104, 110, 116, 101, 114, 67, 108, 111, 99, 107, 119, 105, 115, 101, 67, 111, 110, 116, 111, 117, 114, 73, 110, 116, 101, 103, 114, 97, 108, 59, 25139, 111, 115, 115, 59, 27183, 99, 114, 59, 49152, 55349, 56478, 112, 256, 59, 67, 644, 645, 25299, 97, 112, 59, 25165, 1408, 68, 74, 83, 90, 97, 99, 101, 102, 105, 111, 115, 672, 684, 688, 692, 696, 715, 727, 737, 742, 819, 1165, 256, 59, 111, 377, 677, 116, 114, 97, 104, 100, 59, 26897, 99, 121, 59, 17410, 99, 121, 59, 17413, 99, 121, 59, 17423, 384, 103, 114, 115, 703, 708, 711, 103, 101, 114, 59, 24609, 114, 59, 24993, 104, 118, 59, 27364, 256, 97, 121, 720, 725, 114, 111, 110, 59, 16654, 59, 17428, 108, 256, 59, 116, 733, 734, 25095, 97, 59, 17300, 114, 59, 49152, 55349, 56583, 256, 97, 102, 747, 807, 256, 99, 109, 752, 802, 114, 105, 116, 105, 99, 97, 108, 512, 65, 68, 71, 84, 768, 774, 790, 796, 99, 117, 116, 101, 59, 16564, 111, 372, 779, 781, 59, 17113, 98, 108, 101, 65, 99, 117, 116, 101, 59, 17117, 114, 97, 118, 101, 59, 16480, 105, 108, 100, 101, 59, 17116, 111, 110, 100, 59, 25284, 102, 101, 114, 101, 110, 116, 105, 97, 108, 68, 59, 24902, 1136, 829, 0, 0, 0, 834, 852, 0, 1029, 102, 59, 49152, 55349, 56635, 384, 59, 68, 69, 840, 841, 845, 16552, 111, 116, 59, 24796, 113, 117, 97, 108, 59, 25168, 98, 108, 101, 768, 67, 68, 76, 82, 85, 86, 867, 882, 898, 975, 994, 1016, 111, 110, 116, 111, 117, 114, 73, 110, 116, 101, 103, 114, 97, 236, 569, 111, 628, 889, 0, 0, 891, 187, 841, 110, 65, 114, 114, 111, 119, 59, 25043, 256, 101, 111, 903, 932, 102, 116, 384, 65, 82, 84, 912, 918, 929, 114, 114, 111, 119, 59, 25040, 105, 103, 104, 116, 65, 114, 114, 111, 119, 59, 25044, 101, 229, 714, 110, 103, 256, 76, 82, 939, 964, 101, 102, 116, 256, 65, 82, 947, 953, 114, 114, 111, 119, 59, 26616, 105, 103, 104, 116, 65, 114, 114, 111, 119, 59, 26618, 105, 103, 104, 116, 65, 114, 114, 111, 119, 59, 26617, 105, 103, 104, 116, 256, 65, 84, 984, 990, 114, 114, 111, 119, 59, 25042, 101, 101, 59, 25256, 112, 577, 1001, 0, 0, 1007, 114, 114, 111, 119, 59, 25041, 111, 119, 110, 65, 114, 114, 111, 119, 59, 25045, 101, 114, 116, 105, 99, 97, 108, 66, 97, 114, 59, 25125, 110, 768, 65, 66, 76, 82, 84, 97, 1042, 1066, 1072, 1118, 1151, 892, 114, 114, 111, 119, 384, 59, 66, 85, 1053, 1054, 1058, 24979, 97, 114, 59, 26899, 112, 65, 114, 114, 111, 119, 59, 25077, 114, 101, 118, 101, 59, 17169, 101, 102, 116, 722, 1082, 0, 1094, 0, 1104, 105, 103, 104, 116, 86, 101, 99, 116, 111, 114, 59, 26960, 101, 101, 86, 101, 99, 116, 111, 114, 59, 26974, 101, 99, 116, 111, 114, 256, 59, 66, 1113, 1114, 25021, 97, 114, 59, 26966, 105, 103, 104, 116, 468, 1127, 0, 1137, 101, 101, 86, 101, 99, 116, 111, 114, 59, 26975, 101, 99, 116, 111, 114, 256, 59, 66, 1146, 1147, 25025, 97, 114, 59, 26967, 101, 101, 256, 59, 65, 1158, 1159, 25252, 114, 114, 111, 119, 59, 24999, 256, 99, 116, 1170, 1175, 114, 59, 49152, 55349, 56479, 114, 111, 107, 59, 16656, 2048, 78, 84, 97, 99, 100, 102, 103, 108, 109, 111, 112, 113, 115, 116, 117, 120, 1213, 1216, 1220, 1227, 1246, 1250, 1255, 1262, 1269, 1313, 1327, 1334, 1362, 1373, 1376, 1381, 71, 59, 16714, 72, 32827, 208, 16592, 99, 117, 116, 101, 32827, 201, 16585, 384, 97, 105, 121, 1234, 1239, 1244, 114, 111, 110, 59, 16666, 114, 99, 32827, 202, 16586, 59, 17453, 111, 116, 59, 16662, 114, 59, 49152, 55349, 56584, 114, 97, 118, 101, 32827, 200, 16584, 101, 109, 101, 110, 116, 59, 25096, 256, 97, 112, 1274, 1278, 99, 114, 59, 16658, 116, 121, 595, 1286, 0, 0, 1298, 109, 97, 108, 108, 83, 113, 117, 97, 114, 101, 59, 26107, 101, 114, 121, 83, 109, 97, 108, 108, 83, 113, 117, 97, 114, 101, 59, 26027, 256, 103, 112, 1318, 1322, 111, 110, 59, 16664, 102, 59, 49152, 55349, 56636, 115, 105, 108, 111, 110, 59, 17301, 117, 256, 97, 105, 1340, 1353, 108, 256, 59, 84, 1346, 1347, 27253, 105, 108, 100, 101, 59, 25154, 108, 105, 98, 114, 105, 117, 109, 59, 25036, 256, 99, 105, 1367, 1370, 114, 59, 24880, 109, 59, 27251, 97, 59, 17303, 109, 108, 32827, 203, 16587, 256, 105, 112, 1386, 1391, 115, 116, 115, 59, 25091, 111, 110, 101, 110, 116, 105, 97, 108, 69, 59, 24903, 640, 99, 102, 105, 111, 115, 1413, 1416, 1421, 1458, 1484, 121, 59, 17444, 114, 59, 49152, 55349, 56585, 108, 108, 101, 100, 595, 1431, 0, 0, 1443, 109, 97, 108, 108, 83, 113, 117, 97, 114, 101, 59, 26108, 101, 114, 121, 83, 109, 97, 108, 108, 83, 113, 117, 97, 114, 101, 59, 26026, 880, 1466, 0, 1471, 0, 0, 1476, 102, 59, 49152, 55349, 56637, 65, 108, 108, 59, 25088, 114, 105, 101, 114, 116, 114, 102, 59, 24881, 99, 242, 1483, 1536, 74, 84, 97, 98, 99, 100, 102, 103, 111, 114, 115, 116, 1512, 1516, 1519, 1530, 1536, 1554, 1558, 1563, 1565, 1571, 1644, 1650, 99, 121, 59, 17411, 32827, 62, 16446, 109, 109, 97, 256, 59, 100, 1527, 1528, 17299, 59, 17372, 114, 101, 118, 101, 59, 16670, 384, 101, 105, 121, 1543, 1548, 1552, 100, 105, 108, 59, 16674, 114, 99, 59, 16668, 59, 17427, 111, 116, 59, 16672, 114, 59, 49152, 55349, 56586, 59, 25305, 112, 102, 59, 49152, 55349, 56638, 101, 97, 116, 101, 114, 768, 69, 70, 71, 76, 83, 84, 1589, 1604, 1614, 1622, 1627, 1638, 113, 117, 97, 108, 256, 59, 76, 1598, 1599, 25189, 101, 115, 115, 59, 25307, 117, 108, 108, 69, 113, 117, 97, 108, 59, 25191, 114, 101, 97, 116, 101, 114, 59, 27298, 101, 115, 115, 59, 25207, 108, 97, 110, 116, 69, 113, 117, 97, 108, 59, 27262, 105, 108, 100, 101, 59, 25203, 99, 114, 59, 49152, 55349, 56482, 59, 25195, 1024, 65, 97, 99, 102, 105, 111, 115, 117, 1669, 1675, 1686, 1691, 1694, 1706, 1726, 1738, 82, 68, 99, 121, 59, 17450, 256, 99, 116, 1680, 1684, 101, 107, 59, 17095, 59, 16478, 105, 114, 99, 59, 16676, 114, 59, 24844, 108, 98, 101, 114, 116, 83, 112, 97, 99, 101, 59, 24843, 496, 1711, 0, 1714, 102, 59, 24845, 105, 122, 111, 110, 116, 97, 108, 76, 105, 110, 101, 59, 25856, 256, 99, 116, 1731, 1733, 242, 1705, 114, 111, 107, 59, 16678, 109, 112, 324, 1744, 1752, 111, 119, 110, 72, 117, 109, 240, 303, 113, 117, 97, 108, 59, 25167, 1792, 69, 74, 79, 97, 99, 100, 102, 103, 109, 110, 111, 115, 116, 117, 1786, 1790, 1795, 1799, 1806, 1818, 1822, 1825, 1832, 1860, 1912, 1931, 1935, 1941, 99, 121, 59, 17429, 108, 105, 103, 59, 16690, 99, 121, 59, 17409, 99, 117, 116, 101, 32827, 205, 16589, 256, 105, 121, 1811, 1816, 114, 99, 32827, 206, 16590, 59, 17432, 111, 116, 59, 16688, 114, 59, 24849, 114, 97, 118, 101, 32827, 204, 16588, 384, 59, 97, 112, 1824, 1839, 1855, 256, 99, 103, 1844, 1847, 114, 59, 16682, 105, 110, 97, 114, 121, 73, 59, 24904, 108, 105, 101, 243, 989, 500, 1865, 0, 1890, 256, 59, 101, 1869, 1870, 25132, 256, 103, 114, 1875, 1880, 114, 97, 108, 59, 25131, 115, 101, 99, 116, 105, 111, 110, 59, 25282, 105, 115, 105, 98, 108, 101, 256, 67, 84, 1900, 1906, 111, 109, 109, 97, 59, 24675, 105, 109, 101, 115, 59, 24674, 384, 103, 112, 116, 1919, 1923, 1928, 111, 110, 59, 16686, 102, 59, 49152, 55349, 56640, 97, 59, 17305, 99, 114, 59, 24848, 105, 108, 100, 101, 59, 16680, 491, 1946, 0, 1950, 99, 121, 59, 17414, 108, 32827, 207, 16591, 640, 99, 102, 111, 115, 117, 1964, 1975, 1980, 1986, 2000, 256, 105, 121, 1969, 1973, 114, 99, 59, 16692, 59, 17433, 114, 59, 49152, 55349, 56589, 112, 102, 59, 49152, 55349, 56641, 483, 1991, 0, 1996, 114, 59, 49152, 55349, 56485, 114, 99, 121, 59, 17416, 107, 99, 121, 59, 17412, 896, 72, 74, 97, 99, 102, 111, 115, 2020, 2024, 2028, 2033, 2045, 2050, 2056, 99, 121, 59, 17445, 99, 121, 59, 17420, 112, 112, 97, 59, 17306, 256, 101, 121, 2038, 2043, 100, 105, 108, 59, 16694, 59, 17434, 114, 59, 49152, 55349, 56590, 112, 102, 59, 49152, 55349, 56642, 99, 114, 59, 49152, 55349, 56486, 1408, 74, 84, 97, 99, 101, 102, 108, 109, 111, 115, 116, 2085, 2089, 2092, 2128, 2147, 2483, 2488, 2503, 2509, 2615, 2631, 99, 121, 59, 17417, 32827, 60, 16444, 640, 99, 109, 110, 112, 114, 2103, 2108, 2113, 2116, 2125, 117, 116, 101, 59, 16697, 98, 100, 97, 59, 17307, 103, 59, 26602, 108, 97, 99, 101, 116, 114, 102, 59, 24850, 114, 59, 24990, 384, 97, 101, 121, 2135, 2140, 2145, 114, 111, 110, 59, 16701, 100, 105, 108, 59, 16699, 59, 17435, 256, 102, 115, 2152, 2416, 116, 1280, 65, 67, 68, 70, 82, 84, 85, 86, 97, 114, 2174, 2217, 2225, 2272, 2278, 2300, 2351, 2395, 912, 2410, 256, 110, 114, 2179, 2191, 103, 108, 101, 66, 114, 97, 99, 107, 101, 116, 59, 26600, 114, 111, 119, 384, 59, 66, 82, 2201, 2202, 2206, 24976, 97, 114, 59, 25060, 105, 103, 104, 116, 65, 114, 114, 111, 119, 59, 25030, 101, 105, 108, 105, 110, 103, 59, 25352, 111, 501, 2231, 0, 2243, 98, 108, 101, 66, 114, 97, 99, 107, 101, 116, 59, 26598, 110, 468, 2248, 0, 2258, 101, 101, 86, 101, 99, 116, 111, 114, 59, 26977, 101, 99, 116, 111, 114, 256, 59, 66, 2267, 2268, 25027, 97, 114, 59, 26969, 108, 111, 111, 114, 59, 25354, 105, 103, 104, 116, 256, 65, 86, 2287, 2293, 114, 114, 111, 119, 59, 24980, 101, 99, 116, 111, 114, 59, 26958, 256, 101, 114, 2305, 2327, 101, 384, 59, 65, 86, 2313, 2314, 2320, 25251, 114, 114, 111, 119, 59, 24996, 101, 99, 116, 111, 114, 59, 26970, 105, 97, 110, 103, 108, 101, 384, 59, 66, 69, 2340, 2341, 2345, 25266, 97, 114, 59, 27087, 113, 117, 97, 108, 59, 25268, 112, 384, 68, 84, 86, 2359, 2370, 2380, 111, 119, 110, 86, 101, 99, 116, 111, 114, 59, 26961, 101, 101, 86, 101, 99, 116, 111, 114, 59, 26976, 101, 99, 116, 111, 114, 256, 59, 66, 2390, 2391, 25023, 97, 114, 59, 26968, 101, 99, 116, 111, 114, 256, 59, 66, 2405, 2406, 25020, 97, 114, 59, 26962, 105, 103, 104, 116, 225, 924, 115, 768, 69, 70, 71, 76, 83, 84, 2430, 2443, 2453, 2461, 2466, 2477, 113, 117, 97, 108, 71, 114, 101, 97, 116, 101, 114, 59, 25306, 117, 108, 108, 69, 113, 117, 97, 108, 59, 25190, 114, 101, 97, 116, 101, 114, 59, 25206, 101, 115, 115, 59, 27297, 108, 97, 110, 116, 69, 113, 117, 97, 108, 59, 27261, 105, 108, 100, 101, 59, 25202, 114, 59, 49152, 55349, 56591, 256, 59, 101, 2493, 2494, 25304, 102, 116, 97, 114, 114, 111, 119, 59, 25050, 105, 100, 111, 116, 59, 16703, 384, 110, 112, 119, 2516, 2582, 2587, 103, 512, 76, 82, 108, 114, 2526, 2551, 2562, 2576, 101, 102, 116, 256, 65, 82, 2534, 2540, 114, 114, 111, 119, 59, 26613, 105, 103, 104, 116, 65, 114, 114, 111, 119, 59, 26615, 105, 103, 104, 116, 65, 114, 114, 111, 119, 59, 26614, 101, 102, 116, 256, 97, 114, 947, 2570, 105, 103, 104, 116, 225, 959, 105, 103, 104, 116, 225, 970, 102, 59, 49152, 55349, 56643, 101, 114, 256, 76, 82, 2594, 2604, 101, 102, 116, 65, 114, 114, 111, 119, 59, 24985, 105, 103, 104, 116, 65, 114, 114, 111, 119, 59, 24984, 384, 99, 104, 116, 2622, 2624, 2626, 242, 2124, 59, 25008, 114, 111, 107, 59, 16705, 59, 25194, 1024, 97, 99, 101, 102, 105, 111, 115, 117, 2650, 2653, 2656, 2679, 2684, 2693, 2699, 2702, 112, 59, 26885, 121, 59, 17436, 256, 100, 108, 2661, 2671, 105, 117, 109, 83, 112, 97, 99, 101, 59, 24671, 108, 105, 110, 116, 114, 102, 59, 24883, 114, 59, 49152, 55349, 56592, 110, 117, 115, 80, 108, 117, 115, 59, 25107, 112, 102, 59, 49152, 55349, 56644, 99, 242, 2678, 59, 17308, 1152, 74, 97, 99, 101, 102, 111, 115, 116, 117, 2723, 2727, 2733, 2752, 2836, 2841, 3473, 3479, 3486, 99, 121, 59, 17418, 99, 117, 116, 101, 59, 16707, 384, 97, 101, 121, 2740, 2745, 2750, 114, 111, 110, 59, 16711, 100, 105, 108, 59, 16709, 59, 17437, 384, 103, 115, 119, 2759, 2800, 2830, 97, 116, 105, 118, 101, 384, 77, 84, 86, 2771, 2783, 2792, 101, 100, 105, 117, 109, 83, 112, 97, 99, 101, 59, 24587, 104, 105, 256, 99, 110, 2790, 2776, 235, 2777, 101, 114, 121, 84, 104, 105, 238, 2777, 116, 101, 100, 256, 71, 76, 2808, 2822, 114, 101, 97, 116, 101, 114, 71, 114, 101, 97, 116, 101, 242, 1651, 101, 115, 115, 76, 101, 115, 243, 2632, 76, 105, 110, 101, 59, 16394, 114, 59, 49152, 55349, 56593, 512, 66, 110, 112, 116, 2850, 2856, 2871, 2874, 114, 101, 97, 107, 59, 24672, 66, 114, 101, 97, 107, 105, 110, 103, 83, 112, 97, 99, 101, 59, 16544, 102, 59, 24853, 1664, 59, 67, 68, 69, 71, 72, 76, 78, 80, 82, 83, 84, 86, 2901, 2902, 2922, 2940, 2977, 3051, 3076, 3166, 3204, 3238, 3288, 3425, 3461, 27372, 256, 111, 117, 2907, 2916, 110, 103, 114, 117, 101, 110, 116, 59, 25186, 112, 67, 97, 112, 59, 25197, 111, 117, 98, 108, 101, 86, 101, 114, 116, 105, 99, 97, 108, 66, 97, 114, 59, 25126, 384, 108, 113, 120, 2947, 2954, 2971, 101, 109, 101, 110, 116, 59, 25097, 117, 97, 108, 256, 59, 84, 2962, 2963, 25184, 105, 108, 100, 101, 59, 49152, 8770, 824, 105, 115, 116, 115, 59, 25092, 114, 101, 97, 116, 101, 114, 896, 59, 69, 70, 71, 76, 83, 84, 2998, 2999, 3005, 3017, 3027, 3032, 3045, 25199, 113, 117, 97, 108, 59, 25201, 117, 108, 108, 69, 113, 117, 97, 108, 59, 49152, 8807, 824, 114, 101, 97, 116, 101, 114, 59, 49152, 8811, 824, 101, 115, 115, 59, 25209, 108, 97, 110, 116, 69, 113, 117, 97, 108, 59, 49152, 10878, 824, 105, 108, 100, 101, 59, 25205, 117, 109, 112, 324, 3058, 3069, 111, 119, 110, 72, 117, 109, 112, 59, 49152, 8782, 824, 113, 117, 97, 108, 59, 49152, 8783, 824, 101, 256, 102, 115, 3082, 3111, 116, 84, 114, 105, 97, 110, 103, 108, 101, 384, 59, 66, 69, 3098, 3099, 3105, 25322, 97, 114, 59, 49152, 10703, 824, 113, 117, 97, 108, 59, 25324, 115, 768, 59, 69, 71, 76, 83, 84, 3125, 3126, 3132, 3140, 3147, 3160, 25198, 113, 117, 97, 108, 59, 25200, 114, 101, 97, 116, 101, 114, 59, 25208, 101, 115, 115, 59, 49152, 8810, 824, 108, 97, 110, 116, 69, 113, 117, 97, 108, 59, 49152, 10877, 824, 105, 108, 100, 101, 59, 25204, 101, 115, 116, 101, 100, 256, 71, 76, 3176, 3193, 114, 101, 97, 116, 101, 114, 71, 114, 101, 97, 116, 101, 114, 59, 49152, 10914, 824, 101, 115, 115, 76, 101, 115, 115, 59, 49152, 10913, 824, 114, 101, 99, 101, 100, 101, 115, 384, 59, 69, 83, 3218, 3219, 3227, 25216, 113, 117, 97, 108, 59, 49152, 10927, 824, 108, 97, 110, 116, 69, 113, 117, 97, 108, 59, 25312, 256, 101, 105, 3243, 3257, 118, 101, 114, 115, 101, 69, 108, 101, 109, 101, 110, 116, 59, 25100, 103, 104, 116, 84, 114, 105, 97, 110, 103, 108, 101, 384, 59, 66, 69, 3275, 3276, 3282, 25323, 97, 114, 59, 49152, 10704, 824, 113, 117, 97, 108, 59, 25325, 256, 113, 117, 3293, 3340, 117, 97, 114, 101, 83, 117, 256, 98, 112, 3304, 3321, 115, 101, 116, 256, 59, 69, 3312, 3315, 49152, 8847, 824, 113, 117, 97, 108, 59, 25314, 101, 114, 115, 101, 116, 256, 59, 69, 3331, 3334, 49152, 8848, 824, 113, 117, 97, 108, 59, 25315, 384, 98, 99, 112, 3347, 3364, 3406, 115, 101, 116, 256, 59, 69, 3355, 3358, 49152, 8834, 8402, 113, 117, 97, 108, 59, 25224, 99, 101, 101, 100, 115, 512, 59, 69, 83, 84, 3378, 3379, 3387, 3398, 25217, 113, 117, 97, 108, 59, 49152, 10928, 824, 108, 97, 110, 116, 69, 113, 117, 97, 108, 59, 25313, 105, 108, 100, 101, 59, 49152, 8831, 824, 101, 114, 115, 101, 116, 256, 59, 69, 3416, 3419, 49152, 8835, 8402, 113, 117, 97, 108, 59, 25225, 105, 108, 100, 101, 512, 59, 69, 70, 84, 3438, 3439, 3445, 3455, 25153, 113, 117, 97, 108, 59, 25156, 117, 108, 108, 69, 113, 117, 97, 108, 59, 25159, 105, 108, 100, 101, 59, 25161, 101, 114, 116, 105, 99, 97, 108, 66, 97, 114, 59, 25124, 99, 114, 59, 49152, 55349, 56489, 105, 108, 100, 101, 32827, 209, 16593, 59, 17309, 1792, 69, 97, 99, 100, 102, 103, 109, 111, 112, 114, 115, 116, 117, 118, 3517, 3522, 3529, 3541, 3547, 3552, 3559, 3580, 3586, 3616, 3618, 3634, 3647, 3652, 108, 105, 103, 59, 16722, 99, 117, 116, 101, 32827, 211, 16595, 256, 105, 121, 3534, 3539, 114, 99, 32827, 212, 16596, 59, 17438, 98, 108, 97, 99, 59, 16720, 114, 59, 49152, 55349, 56594, 114, 97, 118, 101, 32827, 210, 16594, 384, 97, 101, 105, 3566, 3570, 3574, 99, 114, 59, 16716, 103, 97, 59, 17321, 99, 114, 111, 110, 59, 17311, 112, 102, 59, 49152, 55349, 56646, 101, 110, 67, 117, 114, 108, 121, 256, 68, 81, 3598, 3610, 111, 117, 98, 108, 101, 81, 117, 111, 116, 101, 59, 24604, 117, 111, 116, 101, 59, 24600, 59, 27220, 256, 99, 108, 3623, 3628, 114, 59, 49152, 55349, 56490, 97, 115, 104, 32827, 216, 16600, 105, 364, 3639, 3644, 100, 101, 32827, 213, 16597, 101, 115, 59, 27191, 109, 108, 32827, 214, 16598, 101, 114, 256, 66, 80, 3659, 3680, 256, 97, 114, 3664, 3667, 114, 59, 24638, 97, 99, 256, 101, 107, 3674, 3676, 59, 25566, 101, 116, 59, 25524, 97, 114, 101, 110, 116, 104, 101, 115, 105, 115, 59, 25564, 1152, 97, 99, 102, 104, 105, 108, 111, 114, 115, 3711, 3719, 3722, 3727, 3730, 3732, 3741, 3760, 3836, 114, 116, 105, 97, 108, 68, 59, 25090, 121, 59, 17439, 114, 59, 49152, 55349, 56595, 105, 59, 17318, 59, 17312, 117, 115, 77, 105, 110, 117, 115, 59, 16561, 256, 105, 112, 3746, 3757, 110, 99, 97, 114, 101, 112, 108, 97, 110, 229, 1693, 102, 59, 24857, 512, 59, 101, 105, 111, 3769, 3770, 3808, 3812, 27323, 99, 101, 100, 101, 115, 512, 59, 69, 83, 84, 3784, 3785, 3791, 3802, 25210, 113, 117, 97, 108, 59, 27311, 108, 97, 110, 116, 69, 113, 117, 97, 108, 59, 25212, 105, 108, 100, 101, 59, 25214, 109, 101, 59, 24627, 256, 100, 112, 3817, 3822, 117, 99, 116, 59, 25103, 111, 114, 116, 105, 111, 110, 256, 59, 97, 549, 3833, 108, 59, 25117, 256, 99, 105, 3841, 3846, 114, 59, 49152, 55349, 56491, 59, 17320, 512, 85, 102, 111, 115, 3857, 3862, 3867, 3871, 79, 84, 32827, 34, 16418, 114, 59, 49152, 55349, 56596, 112, 102, 59, 24858, 99, 114, 59, 49152, 55349, 56492, 1536, 66, 69, 97, 99, 101, 102, 104, 105, 111, 114, 115, 117, 3902, 3907, 3911, 3936, 3955, 4007, 4010, 4013, 4246, 4265, 4276, 4286, 97, 114, 114, 59, 26896, 71, 32827, 174, 16558, 384, 99, 110, 114, 3918, 3923, 3926, 117, 116, 101, 59, 16724, 103, 59, 26603, 114, 256, 59, 116, 3932, 3933, 24992, 108, 59, 26902, 384, 97, 101, 121, 3943, 3948, 3953, 114, 111, 110, 59, 16728, 100, 105, 108, 59, 16726, 59, 17440, 256, 59, 118, 3960, 3961, 24860, 101, 114, 115, 101, 256, 69, 85, 3970, 3993, 256, 108, 113, 3975, 3982, 101, 109, 101, 110, 116, 59, 25099, 117, 105, 108, 105, 98, 114, 105, 117, 109, 59, 25035, 112, 69, 113, 117, 105, 108, 105, 98, 114, 105, 117, 109, 59, 26991, 114, 187, 3961, 111, 59, 17313, 103, 104, 116, 1024, 65, 67, 68, 70, 84, 85, 86, 97, 4033, 4075, 4083, 4130, 4136, 4187, 4231, 984, 256, 110, 114, 4038, 4050, 103, 108, 101, 66, 114, 97, 99, 107, 101, 116, 59, 26601, 114, 111, 119, 384, 59, 66, 76, 4060, 4061, 4065, 24978, 97, 114, 59, 25061, 101, 102, 116, 65, 114, 114, 111, 119, 59, 25028, 101, 105, 108, 105, 110, 103, 59, 25353, 111, 501, 4089, 0, 4101, 98, 108, 101, 66, 114, 97, 99, 107, 101, 116, 59, 26599, 110, 468, 4106, 0, 4116, 101, 101, 86, 101, 99, 116, 111, 114, 59, 26973, 101, 99, 116, 111, 114, 256, 59, 66, 4125, 4126, 25026, 97, 114, 59, 26965, 108, 111, 111, 114, 59, 25355, 256, 101, 114, 4141, 4163, 101, 384, 59, 65, 86, 4149, 4150, 4156, 25250, 114, 114, 111, 119, 59, 24998, 101, 99, 116, 111, 114, 59, 26971, 105, 97, 110, 103, 108, 101, 384, 59, 66, 69, 4176, 4177, 4181, 25267, 97, 114, 59, 27088, 113, 117, 97, 108, 59, 25269, 112, 384, 68, 84, 86, 4195, 4206, 4216, 111, 119, 110, 86, 101, 99, 116, 111, 114, 59, 26959, 101, 101, 86, 101, 99, 116, 111, 114, 59, 26972, 101, 99, 116, 111, 114, 256, 59, 66, 4226, 4227, 25022, 97, 114, 59, 26964, 101, 99, 116, 111, 114, 256, 59, 66, 4241, 4242, 25024, 97, 114, 59, 26963, 256, 112, 117, 4251, 4254, 102, 59, 24861, 110, 100, 73, 109, 112, 108, 105, 101, 115, 59, 26992, 105, 103, 104, 116, 97, 114, 114, 111, 119, 59, 25051, 256, 99, 104, 4281, 4284, 114, 59, 24859, 59, 25009, 108, 101, 68, 101, 108, 97, 121, 101, 100, 59, 27124, 1664, 72, 79, 97, 99, 102, 104, 105, 109, 111, 113, 115, 116, 117, 4324, 4337, 4343, 4349, 4377, 4382, 4433, 4438, 4449, 4455, 4533, 4539, 4543, 256, 67, 99, 4329, 4334, 72, 99, 121, 59, 17449, 121, 59, 17448, 70, 84, 99, 121, 59, 17452, 99, 117, 116, 101, 59, 16730, 640, 59, 97, 101, 105, 121, 4360, 4361, 4366, 4371, 4375, 27324, 114, 111, 110, 59, 16736, 100, 105, 108, 59, 16734, 114, 99, 59, 16732, 59, 17441, 114, 59, 49152, 55349, 56598, 111, 114, 116, 512, 68, 76, 82, 85, 4394, 4404, 4414, 4425, 111, 119, 110, 65, 114, 114, 111, 119, 187, 1054, 101, 102, 116, 65, 114, 114, 111, 119, 187, 2202, 105, 103, 104, 116, 65, 114, 114, 111, 119, 187, 4061, 112, 65, 114, 114, 111, 119, 59, 24977, 103, 109, 97, 59, 17315, 97, 108, 108, 67, 105, 114, 99, 108, 101, 59, 25112, 112, 102, 59, 49152, 55349, 56650, 626, 4461, 0, 0, 4464, 116, 59, 25114, 97, 114, 101, 512, 59, 73, 83, 85, 4475, 4476, 4489, 4527, 26017, 110, 116, 101, 114, 115, 101, 99, 116, 105, 111, 110, 59, 25235, 117, 256, 98, 112, 4495, 4510, 115, 101, 116, 256, 59, 69, 4503, 4504, 25231, 113, 117, 97, 108, 59, 25233, 101, 114, 115, 101, 116, 256, 59, 69, 4520, 4521, 25232, 113, 117, 97, 108, 59, 25234, 110, 105, 111, 110, 59, 25236, 99, 114, 59, 49152, 55349, 56494, 97, 114, 59, 25286, 512, 98, 99, 109, 112, 4552, 4571, 4617, 4619, 256, 59, 115, 4557, 4558, 25296, 101, 116, 256, 59, 69, 4557, 4565, 113, 117, 97, 108, 59, 25222, 256, 99, 104, 4576, 4613, 101, 101, 100, 115, 512, 59, 69, 83, 84, 4589, 4590, 4596, 4607, 25211, 113, 117, 97, 108, 59, 27312, 108, 97, 110, 116, 69, 113, 117, 97, 108, 59, 25213, 105, 108, 100, 101, 59, 25215, 84, 104, 225, 3980, 59, 25105, 384, 59, 101, 115, 4626, 4627, 4643, 25297, 114, 115, 101, 116, 256, 59, 69, 4636, 4637, 25219, 113, 117, 97, 108, 59, 25223, 101, 116, 187, 4627, 1408, 72, 82, 83, 97, 99, 102, 104, 105, 111, 114, 115, 4670, 4676, 4681, 4693, 4702, 4721, 4726, 4767, 4802, 4808, 4817, 79, 82, 78, 32827, 222, 16606, 65, 68, 69, 59, 24866, 256, 72, 99, 4686, 4690, 99, 121, 59, 17419, 121, 59, 17446, 256, 98, 117, 4698, 4700, 59, 16393, 59, 17316, 384, 97, 101, 121, 4709, 4714, 4719, 114, 111, 110, 59, 16740, 100, 105, 108, 59, 16738, 59, 17442, 114, 59, 49152, 55349, 56599, 256, 101, 105, 4731, 4745, 498, 4736, 0, 4743, 101, 102, 111, 114, 101, 59, 25140, 97, 59, 17304, 256, 99, 110, 4750, 4760, 107, 83, 112, 97, 99, 101, 59, 49152, 8287, 8202, 83, 112, 97, 99, 101, 59, 24585, 108, 100, 101, 512, 59, 69, 70, 84, 4779, 4780, 4786, 4796, 25148, 113, 117, 97, 108, 59, 25155, 117, 108, 108, 69, 113, 117, 97, 108, 59, 25157, 105, 108, 100, 101, 59, 25160, 112, 102, 59, 49152, 55349, 56651, 105, 112, 108, 101, 68, 111, 116, 59, 24795, 256, 99, 116, 4822, 4827, 114, 59, 49152, 55349, 56495, 114, 111, 107, 59, 16742, 2785, 4855, 4878, 4890, 4902, 0, 4908, 4913, 0, 0, 0, 0, 0, 4920, 4925, 4983, 4997, 0, 5119, 5124, 5130, 5136, 256, 99, 114, 4859, 4865, 117, 116, 101, 32827, 218, 16602, 114, 256, 59, 111, 4871, 4872, 24991, 99, 105, 114, 59, 26953, 114, 483, 4883, 0, 4886, 121, 59, 17422, 118, 101, 59, 16748, 256, 105, 121, 4894, 4899, 114, 99, 32827, 219, 16603, 59, 17443, 98, 108, 97, 99, 59, 16752, 114, 59, 49152, 55349, 56600, 114, 97, 118, 101, 32827, 217, 16601, 97, 99, 114, 59, 16746, 256, 100, 105, 4929, 4969, 101, 114, 256, 66, 80, 4936, 4957, 256, 97, 114, 4941, 4944, 114, 59, 16479, 97, 99, 256, 101, 107, 4951, 4953, 59, 25567, 101, 116, 59, 25525, 97, 114, 101, 110, 116, 104, 101, 115, 105, 115, 59, 25565, 111, 110, 256, 59, 80, 4976, 4977, 25283, 108, 117, 115, 59, 25230, 256, 103, 112, 4987, 4991, 111, 110, 59, 16754, 102, 59, 49152, 55349, 56652, 1024, 65, 68, 69, 84, 97, 100, 112, 115, 5013, 5038, 5048, 5060, 1000, 5074, 5079, 5107, 114, 114, 111, 119, 384, 59, 66, 68, 4432, 5024, 5028, 97, 114, 59, 26898, 111, 119, 110, 65, 114, 114, 111, 119, 59, 25029, 111, 119, 110, 65, 114, 114, 111, 119, 59, 24981, 113, 117, 105, 108, 105, 98, 114, 105, 117, 109, 59, 26990, 101, 101, 256, 59, 65, 5067, 5068, 25253, 114, 114, 111, 119, 59, 24997, 111, 119, 110, 225, 1011, 101, 114, 256, 76, 82, 5086, 5096, 101, 102, 116, 65, 114, 114, 111, 119, 59, 24982, 105, 103, 104, 116, 65, 114, 114, 111, 119, 59, 24983, 105, 256, 59, 108, 5113, 5114, 17362, 111, 110, 59, 17317, 105, 110, 103, 59, 16750, 99, 114, 59, 49152, 55349, 56496, 105, 108, 100, 101, 59, 16744, 109, 108, 32827, 220, 16604, 1152, 68, 98, 99, 100, 101, 102, 111, 115, 118, 5159, 5164, 5168, 5171, 5182, 5253, 5258, 5264, 5270, 97, 115, 104, 59, 25259, 97, 114, 59, 27371, 121, 59, 17426, 97, 115, 104, 256, 59, 108, 5179, 5180, 25257, 59, 27366, 256, 101, 114, 5187, 5189, 59, 25281, 384, 98, 116, 121, 5196, 5200, 5242, 97, 114, 59, 24598, 256, 59, 105, 5199, 5205, 99, 97, 108, 512, 66, 76, 83, 84, 5217, 5221, 5226, 5236, 97, 114, 59, 25123, 105, 110, 101, 59, 16508, 101, 112, 97, 114, 97, 116, 111, 114, 59, 26456, 105, 108, 100, 101, 59, 25152, 84, 104, 105, 110, 83, 112, 97, 99, 101, 59, 24586, 114, 59, 49152, 55349, 56601, 112, 102, 59, 49152, 55349, 56653, 99, 114, 59, 49152, 55349, 56497, 100, 97, 115, 104, 59, 25258, 640, 99, 101, 102, 111, 115, 5287, 5292, 5297, 5302, 5308, 105, 114, 99, 59, 16756, 100, 103, 101, 59, 25280, 114, 59, 49152, 55349, 56602, 112, 102, 59, 49152, 55349, 56654, 99, 114, 59, 49152, 55349, 56498, 512, 102, 105, 111, 115, 5323, 5328, 5330, 5336, 114, 59, 49152, 55349, 56603, 59, 17310, 112, 102, 59, 49152, 55349, 56655, 99, 114, 59, 49152, 55349, 56499, 1152, 65, 73, 85, 97, 99, 102, 111, 115, 117, 5361, 5365, 5369, 5373, 5380, 5391, 5396, 5402, 5408, 99, 121, 59, 17455, 99, 121, 59, 17415, 99, 121, 59, 17454, 99, 117, 116, 101, 32827, 221, 16605, 256, 105, 121, 5385, 5389, 114, 99, 59, 16758, 59, 17451, 114, 59, 49152, 55349, 56604, 112, 102, 59, 49152, 55349, 56656, 99, 114, 59, 49152, 55349, 56500, 109, 108, 59, 16760, 1024, 72, 97, 99, 100, 101, 102, 111, 115, 5429, 5433, 5439, 5451, 5455, 5469, 5472, 5476, 99, 121, 59, 17430, 99, 117, 116, 101, 59, 16761, 256, 97, 121, 5444, 5449, 114, 111, 110, 59, 16765, 59, 17431, 111, 116, 59, 16763, 498, 5460, 0, 5467, 111, 87, 105, 100, 116, 232, 2777, 97, 59, 17302, 114, 59, 24872, 112, 102, 59, 24868, 99, 114, 59, 49152, 55349, 56501, 3041, 5507, 5514, 5520, 0, 5552, 5558, 5567, 0, 0, 0, 0, 5574, 5595, 5611, 5727, 5741, 0, 5781, 5787, 5810, 5817, 0, 5822, 99, 117, 116, 101, 32827, 225, 16609, 114, 101, 118, 101, 59, 16643, 768, 59, 69, 100, 105, 117, 121, 5532, 5533, 5537, 5539, 5544, 5549, 25150, 59, 49152, 8766, 819, 59, 25151, 114, 99, 32827, 226, 16610, 116, 101, 32955, 180, 774, 59, 17456, 108, 105, 103, 32827, 230, 16614, 256, 59, 114, 178, 5562, 59, 49152, 55349, 56606, 114, 97, 118, 101, 32827, 224, 16608, 256, 101, 112, 5578, 5590, 256, 102, 112, 5583, 5588, 115, 121, 109, 59, 24885, 232, 5587, 104, 97, 59, 17329, 256, 97, 112, 5599, 99, 256, 99, 108, 5604, 5607, 114, 59, 16641, 103, 59, 27199, 612, 5616, 0, 0, 5642, 640, 59, 97, 100, 115, 118, 5626, 5627, 5631, 5633, 5639, 25127, 110, 100, 59, 27221, 59, 27228, 108, 111, 112, 101, 59, 27224, 59, 27226, 896, 59, 101, 108, 109, 114, 115, 122, 5656, 5657, 5659, 5662, 5695, 5711, 5721, 25120, 59, 27044, 101, 187, 5657, 115, 100, 256, 59, 97, 5669, 5670, 25121, 1121, 5680, 5682, 5684, 5686, 5688, 5690, 5692, 5694, 59, 27048, 59, 27049, 59, 27050, 59, 27051, 59, 27052, 59, 27053, 59, 27054, 59, 27055, 116, 256, 59, 118, 5701, 5702, 25119, 98, 256, 59, 100, 5708, 5709, 25278, 59, 27037, 256, 112, 116, 5716, 5719, 104, 59, 25122, 187, 185, 97, 114, 114, 59, 25468, 256, 103, 112, 5731, 5735, 111, 110, 59, 16645, 102, 59, 49152, 55349, 56658, 896, 59, 69, 97, 101, 105, 111, 112, 4801, 5755, 5757, 5762, 5764, 5767, 5770, 59, 27248, 99, 105, 114, 59, 27247, 59, 25162, 100, 59, 25163, 115, 59, 16423, 114, 111, 120, 256, 59, 101, 4801, 5778, 241, 5763, 105, 110, 103, 32827, 229, 16613, 384, 99, 116, 121, 5793, 5798, 5800, 114, 59, 49152, 55349, 56502, 59, 16426, 109, 112, 256, 59, 101, 4801, 5807, 241, 648, 105, 108, 100, 101, 32827, 227, 16611, 109, 108, 32827, 228, 16612, 256, 99, 105, 5826, 5832, 111, 110, 105, 110, 244, 626, 110, 116, 59, 27153, 2048, 78, 97, 98, 99, 100, 101, 102, 105, 107, 108, 110, 111, 112, 114, 115, 117, 5869, 5873, 5936, 5948, 5955, 5960, 6008, 6013, 6112, 6118, 6201, 6224, 5901, 6461, 6472, 6512, 111, 116, 59, 27373, 256, 99, 114, 5878, 5918, 107, 512, 99, 101, 112, 115, 5888, 5893, 5901, 5907, 111, 110, 103, 59, 25164, 112, 115, 105, 108, 111, 110, 59, 17398, 114, 105, 109, 101, 59, 24629, 105, 109, 256, 59, 101, 5914, 5915, 25149, 113, 59, 25293, 374, 5922, 5926, 101, 101, 59, 25277, 101, 100, 256, 59, 103, 5932, 5933, 25349, 101, 187, 5933, 114, 107, 256, 59, 116, 4956, 5943, 98, 114, 107, 59, 25526, 256, 111, 121, 5889, 5953, 59, 17457, 113, 117, 111, 59, 24606, 640, 99, 109, 112, 114, 116, 5971, 5979, 5985, 5988, 5992, 97, 117, 115, 256, 59, 101, 266, 265, 112, 116, 121, 118, 59, 27056, 115, 233, 5900, 110, 111, 245, 275, 384, 97, 104, 119, 5999, 6001, 6003, 59, 17330, 59, 24886, 101, 101, 110, 59, 25196, 114, 59, 49152, 55349, 56607, 103, 896, 99, 111, 115, 116, 117, 118, 119, 6029, 6045, 6067, 6081, 6101, 6107, 6110, 384, 97, 105, 117, 6036, 6038, 6042, 240, 1888, 114, 99, 59, 26095, 112, 187, 4977, 384, 100, 112, 116, 6052, 6056, 6061, 111, 116, 59, 27136, 108, 117, 115, 59, 27137, 105, 109, 101, 115, 59, 27138, 625, 6073, 0, 0, 6078, 99, 117, 112, 59, 27142, 97, 114, 59, 26117, 114, 105, 97, 110, 103, 108, 101, 256, 100, 117, 6093, 6098, 111, 119, 110, 59, 26045, 112, 59, 26035, 112, 108, 117, 115, 59, 27140, 101, 229, 5188, 229, 5293, 97, 114, 111, 119, 59, 26893, 384, 97, 107, 111, 6125, 6182, 6197, 256, 99, 110, 6130, 6179, 107, 384, 108, 115, 116, 6138, 1451, 6146, 111, 122, 101, 110, 103, 101, 59, 27115, 114, 105, 97, 110, 103, 108, 101, 512, 59, 100, 108, 114, 6162, 6163, 6168, 6173, 26036, 111, 119, 110, 59, 26046, 101, 102, 116, 59, 26050, 105, 103, 104, 116, 59, 26040, 107, 59, 25635, 433, 6187, 0, 6195, 434, 6191, 0, 6193, 59, 26002, 59, 26001, 52, 59, 26003, 99, 107, 59, 25992, 256, 101, 111, 6206, 6221, 256, 59, 113, 6211, 6214, 49152, 61, 8421, 117, 105, 118, 59, 49152, 8801, 8421, 116, 59, 25360, 512, 112, 116, 119, 120, 6233, 6238, 6247, 6252, 102, 59, 49152, 55349, 56659, 256, 59, 116, 5067, 6243, 111, 109, 187, 5068, 116, 105, 101, 59, 25288, 1536, 68, 72, 85, 86, 98, 100, 104, 109, 112, 116, 117, 118, 6277, 6294, 6314, 6331, 6359, 6363, 6380, 6399, 6405, 6410, 6416, 6433, 512, 76, 82, 108, 114, 6286, 6288, 6290, 6292, 59, 25943, 59, 25940, 59, 25942, 59, 25939, 640, 59, 68, 85, 100, 117, 6305, 6306, 6308, 6310, 6312, 25936, 59, 25958, 59, 25961, 59, 25956, 59, 25959, 512, 76, 82, 108, 114, 6323, 6325, 6327, 6329, 59, 25949, 59, 25946, 59, 25948, 59, 25945, 896, 59, 72, 76, 82, 104, 108, 114, 6346, 6347, 6349, 6351, 6353, 6355, 6357, 25937, 59, 25964, 59, 25955, 59, 25952, 59, 25963, 59, 25954, 59, 25951, 111, 120, 59, 27081, 512, 76, 82, 108, 114, 6372, 6374, 6376, 6378, 59, 25941, 59, 25938, 59, 25872, 59, 25868, 640, 59, 68, 85, 100, 117, 1725, 6391, 6393, 6395, 6397, 59, 25957, 59, 25960, 59, 25900, 59, 25908, 105, 110, 117, 115, 59, 25247, 108, 117, 115, 59, 25246, 105, 109, 101, 115, 59, 25248, 512, 76, 82, 108, 114, 6425, 6427, 6429, 6431, 59, 25947, 59, 25944, 59, 25880, 59, 25876, 896, 59, 72, 76, 82, 104, 108, 114, 6448, 6449, 6451, 6453, 6455, 6457, 6459, 25858, 59, 25962, 59, 25953, 59, 25950, 59, 25916, 59, 25892, 59, 25884, 256, 101, 118, 291, 6466, 98, 97, 114, 32827, 166, 16550, 512, 99, 101, 105, 111, 6481, 6486, 6490, 6496, 114, 59, 49152, 55349, 56503, 109, 105, 59, 24655, 109, 256, 59, 101, 5914, 5916, 108, 384, 59, 98, 104, 6504, 6505, 6507, 16476, 59, 27077, 115, 117, 98, 59, 26568, 364, 6516, 6526, 108, 256, 59, 101, 6521, 6522, 24610, 116, 187, 6522, 112, 384, 59, 69, 101, 303, 6533, 6535, 59, 27310, 256, 59, 113, 1756, 1755, 3297, 6567, 0, 6632, 6673, 6677, 6706, 0, 6711, 6736, 0, 0, 6836, 0, 0, 6849, 0, 0, 6945, 6958, 6989, 6994, 0, 7165, 0, 7180, 384, 99, 112, 114, 6573, 6578, 6621, 117, 116, 101, 59, 16647, 768, 59, 97, 98, 99, 100, 115, 6591, 6592, 6596, 6602, 6613, 6617, 25129, 110, 100, 59, 27204, 114, 99, 117, 112, 59, 27209, 256, 97, 117, 6607, 6610, 112, 59, 27211, 112, 59, 27207, 111, 116, 59, 27200, 59, 49152, 8745, 65024, 256, 101, 111, 6626, 6629, 116, 59, 24641, 238, 1683, 512, 97, 101, 105, 117, 6640, 6651, 6657, 6661, 496, 6645, 0, 6648, 115, 59, 27213, 111, 110, 59, 16653, 100, 105, 108, 32827, 231, 16615, 114, 99, 59, 16649, 112, 115, 256, 59, 115, 6668, 6669, 27212, 109, 59, 27216, 111, 116, 59, 16651, 384, 100, 109, 110, 6683, 6688, 6694, 105, 108, 32955, 184, 429, 112, 116, 121, 118, 59, 27058, 116, 33024, 162, 59, 101, 6701, 6702, 16546, 114, 228, 434, 114, 59, 49152, 55349, 56608, 384, 99, 101, 105, 6717, 6720, 6733, 121, 59, 17479, 99, 107, 256, 59, 109, 6727, 6728, 26387, 97, 114, 107, 187, 6728, 59, 17351, 114, 896, 59, 69, 99, 101, 102, 109, 115, 6751, 6752, 6754, 6763, 6820, 6826, 6830, 26059, 59, 27075, 384, 59, 101, 108, 6761, 6762, 6765, 17094, 113, 59, 25175, 101, 609, 6772, 0, 0, 6792, 114, 114, 111, 119, 256, 108, 114, 6780, 6785, 101, 102, 116, 59, 25018, 105, 103, 104, 116, 59, 25019, 640, 82, 83, 97, 99, 100, 6802, 6804, 6806, 6810, 6815, 187, 3911, 59, 25800, 115, 116, 59, 25243, 105, 114, 99, 59, 25242, 97, 115, 104, 59, 25245, 110, 105, 110, 116, 59, 27152, 105, 100, 59, 27375, 99, 105, 114, 59, 27074, 117, 98, 115, 256, 59, 117, 6843, 6844, 26211, 105, 116, 187, 6844, 748, 6855, 6868, 6906, 0, 6922, 111, 110, 256, 59, 101, 6861, 6862, 16442, 256, 59, 113, 199, 198, 621, 6873, 0, 0, 6882, 97, 256, 59, 116, 6878, 6879, 16428, 59, 16448, 384, 59, 102, 108, 6888, 6889, 6891, 25089, 238, 4448, 101, 256, 109, 120, 6897, 6902, 101, 110, 116, 187, 6889, 101, 243, 589, 487, 6910, 0, 6919, 256, 59, 100, 4795, 6914, 111, 116, 59, 27245, 110, 244, 582, 384, 102, 114, 121, 6928, 6932, 6935, 59, 49152, 55349, 56660, 111, 228, 596, 33024, 169, 59, 115, 341, 6941, 114, 59, 24855, 256, 97, 111, 6949, 6953, 114, 114, 59, 25013, 115, 115, 59, 26391, 256, 99, 117, 6962, 6967, 114, 59, 49152, 55349, 56504, 256, 98, 112, 6972, 6980, 256, 59, 101, 6977, 6978, 27343, 59, 27345, 256, 59, 101, 6985, 6986, 27344, 59, 27346, 100, 111, 116, 59, 25327, 896, 100, 101, 108, 112, 114, 118, 119, 7008, 7020, 7031, 7042, 7084, 7124, 7161, 97, 114, 114, 256, 108, 114, 7016, 7018, 59, 26936, 59, 26933, 624, 7026, 0, 0, 7029, 114, 59, 25310, 99, 59, 25311, 97, 114, 114, 256, 59, 112, 7039, 7040, 25014, 59, 26941, 768, 59, 98, 99, 100, 111, 115, 7055, 7056, 7062, 7073, 7077, 7080, 25130, 114, 99, 97, 112, 59, 27208, 256, 97, 117, 7067, 7070, 112, 59, 27206, 112, 59, 27210, 111, 116, 59, 25229, 114, 59, 27205, 59, 49152, 8746, 65024, 512, 97, 108, 114, 118, 7093, 7103, 7134, 7139, 114, 114, 256, 59, 109, 7100, 7101, 25015, 59, 26940, 121, 384, 101, 118, 119, 7111, 7124, 7128, 113, 624, 7118, 0, 0, 7122, 114, 101, 227, 7027, 117, 227, 7029, 101, 101, 59, 25294, 101, 100, 103, 101, 59, 25295, 101, 110, 32827, 164, 16548, 101, 97, 114, 114, 111, 119, 256, 108, 114, 7150, 7155, 101, 102, 116, 187, 7040, 105, 103, 104, 116, 187, 7101, 101, 228, 7133, 256, 99, 105, 7169, 7175, 111, 110, 105, 110, 244, 503, 110, 116, 59, 25137, 108, 99, 116, 121, 59, 25389, 2432, 65, 72, 97, 98, 99, 100, 101, 102, 104, 105, 106, 108, 111, 114, 115, 116, 117, 119, 122, 7224, 7227, 7231, 7261, 7273, 7285, 7306, 7326, 7340, 7351, 7419, 7423, 7437, 7547, 7569, 7595, 7611, 7622, 7629, 114, 242, 897, 97, 114, 59, 26981, 512, 103, 108, 114, 115, 7240, 7245, 7250, 7252, 103, 101, 114, 59, 24608, 101, 116, 104, 59, 24888, 242, 4403, 104, 256, 59, 118, 7258, 7259, 24592, 187, 2314, 363, 7265, 7271, 97, 114, 111, 119, 59, 26895, 97, 227, 789, 256, 97, 121, 7278, 7283, 114, 111, 110, 59, 16655, 59, 17460, 384, 59, 97, 111, 818, 7292, 7300, 256, 103, 114, 703, 7297, 114, 59, 25034, 116, 115, 101, 113, 59, 27255, 384, 103, 108, 109, 7313, 7316, 7320, 32827, 176, 16560, 116, 97, 59, 17332, 112, 116, 121, 118, 59, 27057, 256, 105, 114, 7331, 7336, 115, 104, 116, 59, 27007, 59, 49152, 55349, 56609, 97, 114, 256, 108, 114, 7347, 7349, 187, 2268, 187, 4126, 640, 97, 101, 103, 115, 118, 7362, 888, 7382, 7388, 7392, 109, 384, 59, 111, 115, 806, 7370, 7380, 110, 100, 256, 59, 115, 806, 7377, 117, 105, 116, 59, 26214, 97, 109, 109, 97, 59, 17373, 105, 110, 59, 25330, 384, 59, 105, 111, 7399, 7400, 7416, 16631, 100, 101, 33024, 247, 59, 111, 7399, 7408, 110, 116, 105, 109, 101, 115, 59, 25287, 110, 248, 7415, 99, 121, 59, 17490, 99, 623, 7430, 0, 0, 7434, 114, 110, 59, 25374, 111, 112, 59, 25357, 640, 108, 112, 116, 117, 119, 7448, 7453, 7458, 7497, 7509, 108, 97, 114, 59, 16420, 102, 59, 49152, 55349, 56661, 640, 59, 101, 109, 112, 115, 779, 7469, 7479, 7485, 7490, 113, 256, 59, 100, 850, 7475, 111, 116, 59, 25169, 105, 110, 117, 115, 59, 25144, 108, 117, 115, 59, 25108, 113, 117, 97, 114, 101, 59, 25249, 98, 108, 101, 98, 97, 114, 119, 101, 100, 103, 229, 250, 110, 384, 97, 100, 104, 4398, 7517, 7527, 111, 119, 110, 97, 114, 114, 111, 119, 243, 7299, 97, 114, 112, 111, 111, 110, 256, 108, 114, 7538, 7542, 101, 102, 244, 7348, 105, 103, 104, 244, 7350, 354, 7551, 7557, 107, 97, 114, 111, 247, 3906, 623, 7562, 0, 0, 7566, 114, 110, 59, 25375, 111, 112, 59, 25356, 384, 99, 111, 116, 7576, 7587, 7590, 256, 114, 121, 7581, 7585, 59, 49152, 55349, 56505, 59, 17493, 108, 59, 27126, 114, 111, 107, 59, 16657, 256, 100, 114, 7600, 7604, 111, 116, 59, 25329, 105, 256, 59, 102, 7610, 6166, 26047, 256, 97, 104, 7616, 7619, 114, 242, 1065, 97, 242, 4006, 97, 110, 103, 108, 101, 59, 27046, 256, 99, 105, 7634, 7637, 121, 59, 17503, 103, 114, 97, 114, 114, 59, 26623, 2304, 68, 97, 99, 100, 101, 102, 103, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 120, 7681, 7689, 7705, 7736, 1400, 7740, 7753, 7777, 7806, 7845, 7855, 7869, 7905, 7978, 7991, 8004, 8014, 8026, 256, 68, 111, 7686, 7476, 111, 244, 7305, 256, 99, 115, 7694, 7700, 117, 116, 101, 32827, 233, 16617, 116, 101, 114, 59, 27246, 512, 97, 105, 111, 121, 7714, 7719, 7729, 7734, 114, 111, 110, 59, 16667, 114, 256, 59, 99, 7725, 7726, 25174, 32827, 234, 16618, 108, 111, 110, 59, 25173, 59, 17485, 111, 116, 59, 16663, 256, 68, 114, 7745, 7749, 111, 116, 59, 25170, 59, 49152, 55349, 56610, 384, 59, 114, 115, 7760, 7761, 7767, 27290, 97, 118, 101, 32827, 232, 16616, 256, 59, 100, 7772, 7773, 27286, 111, 116, 59, 27288, 512, 59, 105, 108, 115, 7786, 7787, 7794, 7796, 27289, 110, 116, 101, 114, 115, 59, 25575, 59, 24851, 256, 59, 100, 7801, 7802, 27285, 111, 116, 59, 27287, 384, 97, 112, 115, 7813, 7817, 7831, 99, 114, 59, 16659, 116, 121, 384, 59, 115, 118, 7826, 7827, 7829, 25093, 101, 116, 187, 7827, 112, 256, 49, 59, 7837, 7844, 307, 7841, 7843, 59, 24580, 59, 24581, 24579, 256, 103, 115, 7850, 7852, 59, 16715, 112, 59, 24578, 256, 103, 112, 7860, 7864, 111, 110, 59, 16665, 102, 59, 49152, 55349, 56662, 384, 97, 108, 115, 7876, 7886, 7890, 114, 256, 59, 115, 7882, 7883, 25301, 108, 59, 27107, 117, 115, 59, 27249, 105, 384, 59, 108, 118, 7898, 7899, 7903, 17333, 111, 110, 187, 7899, 59, 17397, 512, 99, 115, 117, 118, 7914, 7923, 7947, 7971, 256, 105, 111, 7919, 7729, 114, 99, 187, 7726, 617, 7929, 0, 0, 7931, 237, 1352, 97, 110, 116, 256, 103, 108, 7938, 7942, 116, 114, 187, 7773, 101, 115, 115, 187, 7802, 384, 97, 101, 105, 7954, 7958, 7962, 108, 115, 59, 16445, 115, 116, 59, 25183, 118, 256, 59, 68, 565, 7968, 68, 59, 27256, 112, 97, 114, 115, 108, 59, 27109, 256, 68, 97, 7983, 7987, 111, 116, 59, 25171, 114, 114, 59, 26993, 384, 99, 100, 105, 7998, 8001, 7928, 114, 59, 24879, 111, 244, 850, 256, 97, 104, 8009, 8011, 59, 17335, 32827, 240, 16624, 256, 109, 114, 8019, 8023, 108, 32827, 235, 16619, 111, 59, 24748, 384, 99, 105, 112, 8033, 8036, 8039, 108, 59, 16417, 115, 244, 1390, 256, 101, 111, 8044, 8052, 99, 116, 97, 116, 105, 111, 238, 1369, 110, 101, 110, 116, 105, 97, 108, 229, 1401, 2529, 8082, 0, 8094, 0, 8097, 8103, 0, 0, 8134, 8140, 0, 8147, 0, 8166, 8170, 8192, 0, 8200, 8282, 108, 108, 105, 110, 103, 100, 111, 116, 115, 101, 241, 7748, 121, 59, 17476, 109, 97, 108, 101, 59, 26176, 384, 105, 108, 114, 8109, 8115, 8129, 108, 105, 103, 59, 32768, 64259, 617, 8121, 0, 0, 8125, 103, 59, 32768, 64256, 105, 103, 59, 32768, 64260, 59, 49152, 55349, 56611, 108, 105, 103, 59, 32768, 64257, 108, 105, 103, 59, 49152, 102, 106, 384, 97, 108, 116, 8153, 8156, 8161, 116, 59, 26221, 105, 103, 59, 32768, 64258, 110, 115, 59, 26033, 111, 102, 59, 16786, 496, 8174, 0, 8179, 102, 59, 49152, 55349, 56663, 256, 97, 107, 1471, 8183, 256, 59, 118, 8188, 8189, 25300, 59, 27353, 97, 114, 116, 105, 110, 116, 59, 27149, 256, 97, 111, 8204, 8277, 256, 99, 115, 8209, 8274, 945, 8218, 8240, 8248, 8261, 8264, 0, 8272, 946, 8226, 8229, 8231, 8234, 8236, 0, 8238, 32827, 189, 16573, 59, 24915, 32827, 188, 16572, 59, 24917, 59, 24921, 59, 24923, 435, 8244, 0, 8246, 59, 24916, 59, 24918, 692, 8254, 8257, 0, 0, 8259, 32827, 190, 16574, 59, 24919, 59, 24924, 53, 59, 24920, 438, 8268, 0, 8270, 59, 24922, 59, 24925, 56, 59, 24926, 108, 59, 24644, 119, 110, 59, 25378, 99, 114, 59, 49152, 55349, 56507, 2176, 69, 97, 98, 99, 100, 101, 102, 103, 105, 106, 108, 110, 111, 114, 115, 116, 118, 8322, 8329, 8351, 8357, 8368, 8372, 8432, 8437, 8442, 8447, 8451, 8466, 8504, 791, 8510, 8530, 8606, 256, 59, 108, 1613, 8327, 59, 27276, 384, 99, 109, 112, 8336, 8341, 8349, 117, 116, 101, 59, 16885, 109, 97, 256, 59, 100, 8348, 7386, 17331, 59, 27270, 114, 101, 118, 101, 59, 16671, 256, 105, 121, 8362, 8366, 114, 99, 59, 16669, 59, 17459, 111, 116, 59, 16673, 512, 59, 108, 113, 115, 1598, 1602, 8381, 8393, 384, 59, 113, 115, 1598, 1612, 8388, 108, 97, 110, 244, 1637, 512, 59, 99, 100, 108, 1637, 8402, 8405, 8421, 99, 59, 27305, 111, 116, 256, 59, 111, 8412, 8413, 27264, 256, 59, 108, 8418, 8419, 27266, 59, 27268, 256, 59, 101, 8426, 8429, 49152, 8923, 65024, 115, 59, 27284, 114, 59, 49152, 55349, 56612, 256, 59, 103, 1651, 1563, 109, 101, 108, 59, 24887, 99, 121, 59, 17491, 512, 59, 69, 97, 106, 1626, 8460, 8462, 8464, 59, 27282, 59, 27301, 59, 27300, 512, 69, 97, 101, 115, 8475, 8477, 8489, 8500, 59, 25193, 112, 256, 59, 112, 8483, 8484, 27274, 114, 111, 120, 187, 8484, 256, 59, 113, 8494, 8495, 27272, 256, 59, 113, 8494, 8475, 105, 109, 59, 25319, 112, 102, 59, 49152, 55349, 56664, 256, 99, 105, 8515, 8518, 114, 59, 24842, 109, 384, 59, 101, 108, 1643, 8526, 8528, 59, 27278, 59, 27280, 33536, 62, 59, 99, 100, 108, 113, 114, 1518, 8544, 8554, 8558, 8563, 8569, 256, 99, 105, 8549, 8551, 59, 27303, 114, 59, 27258, 111, 116, 59, 25303, 80, 97, 114, 59, 27029, 117, 101, 115, 116, 59, 27260, 640, 97, 100, 101, 108, 115, 8580, 8554, 8592, 1622, 8603, 496, 8585, 0, 8590, 112, 114, 111, 248, 8350, 114, 59, 27000, 113, 256, 108, 113, 1599, 8598, 108, 101, 115, 243, 8328, 105, 237, 1643, 256, 101, 110, 8611, 8621, 114, 116, 110, 101, 113, 113, 59, 49152, 8809, 65024, 197, 8618, 1280, 65, 97, 98, 99, 101, 102, 107, 111, 115, 121, 8644, 8647, 8689, 8693, 8698, 8728, 8733, 8751, 8808, 8829, 114, 242, 928, 512, 105, 108, 109, 114, 8656, 8660, 8663, 8667, 114, 115, 240, 5252, 102, 187, 8228, 105, 108, 244, 1705, 256, 100, 114, 8672, 8676, 99, 121, 59, 17482, 384, 59, 99, 119, 2292, 8683, 8687, 105, 114, 59, 26952, 59, 25005, 97, 114, 59, 24847, 105, 114, 99, 59, 16677, 384, 97, 108, 114, 8705, 8718, 8723, 114, 116, 115, 256, 59, 117, 8713, 8714, 26213, 105, 116, 187, 8714, 108, 105, 112, 59, 24614, 99, 111, 110, 59, 25273, 114, 59, 49152, 55349, 56613, 115, 256, 101, 119, 8739, 8745, 97, 114, 111, 119, 59, 26917, 97, 114, 111, 119, 59, 26918, 640, 97, 109, 111, 112, 114, 8762, 8766, 8771, 8798, 8803, 114, 114, 59, 25087, 116, 104, 116, 59, 25147, 107, 256, 108, 114, 8777, 8787, 101, 102, 116, 97, 114, 114, 111, 119, 59, 25001, 105, 103, 104, 116, 97, 114, 114, 111, 119, 59, 25002, 102, 59, 49152, 55349, 56665, 98, 97, 114, 59, 24597, 384, 99, 108, 116, 8815, 8820, 8824, 114, 59, 49152, 55349, 56509, 97, 115, 232, 8692, 114, 111, 107, 59, 16679, 256, 98, 112, 8834, 8839, 117, 108, 108, 59, 24643, 104, 101, 110, 187, 7259, 2785, 8867, 0, 8874, 0, 8888, 8901, 8910, 0, 8917, 8947, 0, 0, 8952, 8994, 9063, 9058, 9087, 0, 9094, 9130, 9140, 99, 117, 116, 101, 32827, 237, 16621, 384, 59, 105, 121, 1905, 8880, 8885, 114, 99, 32827, 238, 16622, 59, 17464, 256, 99, 120, 8892, 8895, 121, 59, 17461, 99, 108, 32827, 161, 16545, 256, 102, 114, 927, 8905, 59, 49152, 55349, 56614, 114, 97, 118, 101, 32827, 236, 16620, 512, 59, 105, 110, 111, 1854, 8925, 8937, 8942, 256, 105, 110, 8930, 8934, 110, 116, 59, 27148, 116, 59, 25133, 102, 105, 110, 59, 27100, 116, 97, 59, 24873, 108, 105, 103, 59, 16691, 384, 97, 111, 112, 8958, 8986, 8989, 384, 99, 103, 116, 8965, 8968, 8983, 114, 59, 16683, 384, 101, 108, 112, 1823, 8975, 8979, 105, 110, 229, 1934, 97, 114, 244, 1824, 104, 59, 16689, 102, 59, 25271, 101, 100, 59, 16821, 640, 59, 99, 102, 111, 116, 1268, 9004, 9009, 9021, 9025, 97, 114, 101, 59, 24837, 105, 110, 256, 59, 116, 9016, 9017, 25118, 105, 101, 59, 27101, 100, 111, 244, 8985, 640, 59, 99, 101, 108, 112, 1879, 9036, 9040, 9051, 9057, 97, 108, 59, 25274, 256, 103, 114, 9045, 9049, 101, 114, 243, 5475, 227, 9037, 97, 114, 104, 107, 59, 27159, 114, 111, 100, 59, 27196, 512, 99, 103, 112, 116, 9071, 9074, 9078, 9083, 121, 59, 17489, 111, 110, 59, 16687, 102, 59, 49152, 55349, 56666, 97, 59, 17337, 117, 101, 115, 116, 32827, 191, 16575, 256, 99, 105, 9098, 9103, 114, 59, 49152, 55349, 56510, 110, 640, 59, 69, 100, 115, 118, 1268, 9115, 9117, 9121, 1267, 59, 25337, 111, 116, 59, 25333, 256, 59, 118, 9126, 9127, 25332, 59, 25331, 256, 59, 105, 1911, 9134, 108, 100, 101, 59, 16681, 491, 9144, 0, 9148, 99, 121, 59, 17494, 108, 32827, 239, 16623, 768, 99, 102, 109, 111, 115, 117, 9164, 9175, 9180, 9185, 9191, 9205, 256, 105, 121, 9169, 9173, 114, 99, 59, 16693, 59, 17465, 114, 59, 49152, 55349, 56615, 97, 116, 104, 59, 16951, 112, 102, 59, 49152, 55349, 56667, 483, 9196, 0, 9201, 114, 59, 49152, 55349, 56511, 114, 99, 121, 59, 17496, 107, 99, 121, 59, 17492, 1024, 97, 99, 102, 103, 104, 106, 111, 115, 9227, 9238, 9250, 9255, 9261, 9265, 9269, 9275, 112, 112, 97, 256, 59, 118, 9235, 9236, 17338, 59, 17392, 256, 101, 121, 9243, 9248, 100, 105, 108, 59, 16695, 59, 17466, 114, 59, 49152, 55349, 56616, 114, 101, 101, 110, 59, 16696, 99, 121, 59, 17477, 99, 121, 59, 17500, 112, 102, 59, 49152, 55349, 56668, 99, 114, 59, 49152, 55349, 56512, 2944, 65, 66, 69, 72, 97, 98, 99, 100, 101, 102, 103, 104, 106, 108, 109, 110, 111, 112, 114, 115, 116, 117, 118, 9328, 9345, 9350, 9357, 9361, 9486, 9533, 9562, 9600, 9806, 9822, 9829, 9849, 9853, 9882, 9906, 9944, 10077, 10088, 10123, 10176, 10241, 10258, 384, 97, 114, 116, 9335, 9338, 9340, 114, 242, 2502, 242, 917, 97, 105, 108, 59, 26907, 97, 114, 114, 59, 26894, 256, 59, 103, 2452, 9355, 59, 27275, 97, 114, 59, 26978, 2403, 9381, 0, 9386, 0, 9393, 0, 0, 0, 0, 0, 9397, 9402, 0, 9414, 9416, 9421, 0, 9465, 117, 116, 101, 59, 16698, 109, 112, 116, 121, 118, 59, 27060, 114, 97, 238, 2124, 98, 100, 97, 59, 17339, 103, 384, 59, 100, 108, 2190, 9409, 9411, 59, 27025, 229, 2190, 59, 27269, 117, 111, 32827, 171, 16555, 114, 1024, 59, 98, 102, 104, 108, 112, 115, 116, 2201, 9438, 9446, 9449, 9451, 9454, 9457, 9461, 256, 59, 102, 2205, 9443, 115, 59, 26911, 115, 59, 26909, 235, 8786, 112, 59, 25003, 108, 59, 26937, 105, 109, 59, 26995, 108, 59, 24994, 384, 59, 97, 101, 9471, 9472, 9476, 27307, 105, 108, 59, 26905, 256, 59, 115, 9481, 9482, 27309, 59, 49152, 10925, 65024, 384, 97, 98, 114, 9493, 9497, 9501, 114, 114, 59, 26892, 114, 107, 59, 26482, 256, 97, 107, 9506, 9516, 99, 256, 101, 107, 9512, 9514, 59, 16507, 59, 16475, 256, 101, 115, 9521, 9523, 59, 27019, 108, 256, 100, 117, 9529, 9531, 59, 27023, 59, 27021, 512, 97, 101, 117, 121, 9542, 9547, 9558, 9560, 114, 111, 110, 59, 16702, 256, 100, 105, 9552, 9556, 105, 108, 59, 16700, 236, 2224, 226, 9513, 59, 17467, 512, 99, 113, 114, 115, 9571, 9574, 9581, 9597, 97, 59, 26934, 117, 111, 256, 59, 114, 3609, 5958, 256, 100, 117, 9586, 9591, 104, 97, 114, 59, 26983, 115, 104, 97, 114, 59, 26955, 104, 59, 25010, 640, 59, 102, 103, 113, 115, 9611, 9612, 2441, 9715, 9727, 25188, 116, 640, 97, 104, 108, 114, 116, 9624, 9636, 9655, 9666, 9704, 114, 114, 111, 119, 256, 59, 116, 2201, 9633, 97, 233, 9462, 97, 114, 112, 111, 111, 110, 256, 100, 117, 9647, 9652, 111, 119, 110, 187, 1114, 112, 187, 2406, 101, 102, 116, 97, 114, 114, 111, 119, 115, 59, 25031, 105, 103, 104, 116, 384, 97, 104, 115, 9677, 9686, 9694, 114, 114, 111, 119, 256, 59, 115, 2292, 2215, 97, 114, 112, 111, 111, 110, 243, 3992, 113, 117, 105, 103, 97, 114, 114, 111, 247, 8688, 104, 114, 101, 101, 116, 105, 109, 101, 115, 59, 25291, 384, 59, 113, 115, 9611, 2451, 9722, 108, 97, 110, 244, 2476, 640, 59, 99, 100, 103, 115, 2476, 9738, 9741, 9757, 9768, 99, 59, 27304, 111, 116, 256, 59, 111, 9748, 9749, 27263, 256, 59, 114, 9754, 9755, 27265, 59, 27267, 256, 59, 101, 9762, 9765, 49152, 8922, 65024, 115, 59, 27283, 640, 97, 100, 101, 103, 115, 9779, 9785, 9789, 9801, 9803, 112, 112, 114, 111, 248, 9414, 111, 116, 59, 25302, 113, 256, 103, 113, 9795, 9797, 244, 2441, 103, 116, 242, 9356, 244, 2459, 105, 237, 2482, 384, 105, 108, 114, 9813, 2273, 9818, 115, 104, 116, 59, 27004, 59, 49152, 55349, 56617, 256, 59, 69, 2460, 9827, 59, 27281, 353, 9833, 9846, 114, 256, 100, 117, 9650, 9838, 256, 59, 108, 2405, 9843, 59, 26986, 108, 107, 59, 25988, 99, 121, 59, 17497, 640, 59, 97, 99, 104, 116, 2632, 9864, 9867, 9873, 9878, 114, 242, 9665, 111, 114, 110, 101, 242, 7432, 97, 114, 100, 59, 26987, 114, 105, 59, 26106, 256, 105, 111, 9887, 9892, 100, 111, 116, 59, 16704, 117, 115, 116, 256, 59, 97, 9900, 9901, 25520, 99, 104, 101, 187, 9901, 512, 69, 97, 101, 115, 9915, 9917, 9929, 9940, 59, 25192, 112, 256, 59, 112, 9923, 9924, 27273, 114, 111, 120, 187, 9924, 256, 59, 113, 9934, 9935, 27271, 256, 59, 113, 9934, 9915, 105, 109, 59, 25318, 1024, 97, 98, 110, 111, 112, 116, 119, 122, 9961, 9972, 9975, 10010, 10031, 10049, 10055, 10064, 256, 110, 114, 9966, 9969, 103, 59, 26604, 114, 59, 25085, 114, 235, 2241, 103, 384, 108, 109, 114, 9983, 9997, 10004, 101, 102, 116, 256, 97, 114, 2534, 9991, 105, 103, 104, 116, 225, 2546, 97, 112, 115, 116, 111, 59, 26620, 105, 103, 104, 116, 225, 2557, 112, 97, 114, 114, 111, 119, 256, 108, 114, 10021, 10025, 101, 102, 244, 9453, 105, 103, 104, 116, 59, 25004, 384, 97, 102, 108, 10038, 10041, 10045, 114, 59, 27013, 59, 49152, 55349, 56669, 117, 115, 59, 27181, 105, 109, 101, 115, 59, 27188, 353, 10059, 10063, 115, 116, 59, 25111, 225, 4942, 384, 59, 101, 102, 10071, 10072, 6144, 26058, 110, 103, 101, 187, 10072, 97, 114, 256, 59, 108, 10084, 10085, 16424, 116, 59, 27027, 640, 97, 99, 104, 109, 116, 10099, 10102, 10108, 10117, 10119, 114, 242, 2216, 111, 114, 110, 101, 242, 7564, 97, 114, 256, 59, 100, 3992, 10115, 59, 26989, 59, 24590, 114, 105, 59, 25279, 768, 97, 99, 104, 105, 113, 116, 10136, 10141, 2624, 10146, 10158, 10171, 113, 117, 111, 59, 24633, 114, 59, 49152, 55349, 56513, 109, 384, 59, 101, 103, 2482, 10154, 10156, 59, 27277, 59, 27279, 256, 98, 117, 9514, 10163, 111, 256, 59, 114, 3615, 10169, 59, 24602, 114, 111, 107, 59, 16706, 33792, 60, 59, 99, 100, 104, 105, 108, 113, 114, 2091, 10194, 9785, 10204, 10208, 10213, 10218, 10224, 256, 99, 105, 10199, 10201, 59, 27302, 114, 59, 27257, 114, 101, 229, 9714, 109, 101, 115, 59, 25289, 97, 114, 114, 59, 26998, 117, 101, 115, 116, 59, 27259, 256, 80, 105, 10229, 10233, 97, 114, 59, 27030, 384, 59, 101, 102, 10240, 2349, 6171, 26051, 114, 256, 100, 117, 10247, 10253, 115, 104, 97, 114, 59, 26954, 104, 97, 114, 59, 26982, 256, 101, 110, 10263, 10273, 114, 116, 110, 101, 113, 113, 59, 49152, 8808, 65024, 197, 10270, 1792, 68, 97, 99, 100, 101, 102, 104, 105, 108, 110, 111, 112, 115, 117, 10304, 10309, 10370, 10382, 10387, 10400, 10405, 10408, 10458, 10466, 10468, 2691, 10483, 10498, 68, 111, 116, 59, 25146, 512, 99, 108, 112, 114, 10318, 10322, 10339, 10365, 114, 32827, 175, 16559, 256, 101, 116, 10327, 10329, 59, 26178, 256, 59, 101, 10334, 10335, 26400, 115, 101, 187, 10335, 256, 59, 115, 4155, 10344, 116, 111, 512, 59, 100, 108, 117, 4155, 10355, 10359, 10363, 111, 119, 238, 1164, 101, 102, 244, 2319, 240, 5073, 107, 101, 114, 59, 26030, 256, 111, 121, 10375, 10380, 109, 109, 97, 59, 27177, 59, 17468, 97, 115, 104, 59, 24596, 97, 115, 117, 114, 101, 100, 97, 110, 103, 108, 101, 187, 5670, 114, 59, 49152, 55349, 56618, 111, 59, 24871, 384, 99, 100, 110, 10415, 10420, 10441, 114, 111, 32827, 181, 16565, 512, 59, 97, 99, 100, 5220, 10429, 10432, 10436, 115, 244, 5799, 105, 114, 59, 27376, 111, 116, 32955, 183, 437, 117, 115, 384, 59, 98, 100, 10450, 6403, 10451, 25106, 256, 59, 117, 7484, 10456, 59, 27178, 355, 10462, 10465, 112, 59, 27355, 242, 8722, 240, 2689, 256, 100, 112, 10473, 10478, 101, 108, 115, 59, 25255, 102, 59, 49152, 55349, 56670, 256, 99, 116, 10488, 10493, 114, 59, 49152, 55349, 56514, 112, 111, 115, 187, 5533, 384, 59, 108, 109, 10505, 10506, 10509, 17340, 116, 105, 109, 97, 112, 59, 25272, 3072, 71, 76, 82, 86, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 108, 109, 111, 112, 114, 115, 116, 117, 118, 119, 10562, 10579, 10622, 10633, 10648, 10714, 10729, 10773, 10778, 10840, 10845, 10883, 10901, 10916, 10920, 11012, 11015, 11076, 11135, 11182, 11316, 11367, 11388, 11497, 256, 103, 116, 10567, 10571, 59, 49152, 8921, 824, 256, 59, 118, 10576, 3023, 49152, 8811, 8402, 384, 101, 108, 116, 10586, 10610, 10614, 102, 116, 256, 97, 114, 10593, 10599, 114, 114, 111, 119, 59, 25037, 105, 103, 104, 116, 97, 114, 114, 111, 119, 59, 25038, 59, 49152, 8920, 824, 256, 59, 118, 10619, 3143, 49152, 8810, 8402, 105, 103, 104, 116, 97, 114, 114, 111, 119, 59, 25039, 256, 68, 100, 10638, 10643, 97, 115, 104, 59, 25263, 97, 115, 104, 59, 25262, 640, 98, 99, 110, 112, 116, 10659, 10663, 10668, 10673, 10700, 108, 97, 187, 734, 117, 116, 101, 59, 16708, 103, 59, 49152, 8736, 8402, 640, 59, 69, 105, 111, 112, 3460, 10684, 10688, 10693, 10696, 59, 49152, 10864, 824, 100, 59, 49152, 8779, 824, 115, 59, 16713, 114, 111, 248, 3460, 117, 114, 256, 59, 97, 10707, 10708, 26222, 108, 256, 59, 115, 10707, 2872, 499, 10719, 0, 10723, 112, 32955, 160, 2871, 109, 112, 256, 59, 101, 3065, 3072, 640, 97, 101, 111, 117, 121, 10740, 10750, 10755, 10768, 10771, 496, 10745, 0, 10747, 59, 27203, 111, 110, 59, 16712, 100, 105, 108, 59, 16710, 110, 103, 256, 59, 100, 3454, 10762, 111, 116, 59, 49152, 10861, 824, 112, 59, 27202, 59, 17469, 97, 115, 104, 59, 24595, 896, 59, 65, 97, 100, 113, 115, 120, 2962, 10793, 10797, 10811, 10817, 10821, 10832, 114, 114, 59, 25047, 114, 256, 104, 114, 10803, 10806, 107, 59, 26916, 256, 59, 111, 5106, 5104, 111, 116, 59, 49152, 8784, 824, 117, 105, 246, 2915, 256, 101, 105, 10826, 10830, 97, 114, 59, 26920, 237, 2968, 105, 115, 116, 256, 59, 115, 2976, 2975, 114, 59, 49152, 55349, 56619, 512, 69, 101, 115, 116, 3013, 10854, 10873, 10876, 384, 59, 113, 115, 3004, 10861, 3041, 384, 59, 113, 115, 3004, 3013, 10868, 108, 97, 110, 244, 3042, 105, 237, 3050, 256, 59, 114, 2998, 10881, 187, 2999, 384, 65, 97, 112, 10890, 10893, 10897, 114, 242, 10609, 114, 114, 59, 25006, 97, 114, 59, 27378, 384, 59, 115, 118, 3981, 10908, 3980, 256, 59, 100, 10913, 10914, 25340, 59, 25338, 99, 121, 59, 17498, 896, 65, 69, 97, 100, 101, 115, 116, 10935, 10938, 10942, 10946, 10949, 10998, 11001, 114, 242, 10598, 59, 49152, 8806, 824, 114, 114, 59, 24986, 114, 59, 24613, 512, 59, 102, 113, 115, 3131, 10958, 10979, 10991, 116, 256, 97, 114, 10964, 10969, 114, 114, 111, 247, 10945, 105, 103, 104, 116, 97, 114, 114, 111, 247, 10896, 384, 59, 113, 115, 3131, 10938, 10986, 108, 97, 110, 244, 3157, 256, 59, 115, 3157, 10996, 187, 3126, 105, 237, 3165, 256, 59, 114, 3125, 11006, 105, 256, 59, 101, 3098, 3109, 105, 228, 3472, 256, 112, 116, 11020, 11025, 102, 59, 49152, 55349, 56671, 33152, 172, 59, 105, 110, 11033, 11034, 11062, 16556, 110, 512, 59, 69, 100, 118, 2953, 11044, 11048, 11054, 59, 49152, 8953, 824, 111, 116, 59, 49152, 8949, 824, 481, 2953, 11059, 11061, 59, 25335, 59, 25334, 105, 256, 59, 118, 3256, 11068, 481, 3256, 11073, 11075, 59, 25342, 59, 25341, 384, 97, 111, 114, 11083, 11107, 11113, 114, 512, 59, 97, 115, 116, 2939, 11093, 11098, 11103, 108, 108, 101, 236, 2939, 108, 59, 49152, 11005, 8421, 59, 49152, 8706, 824, 108, 105, 110, 116, 59, 27156, 384, 59, 99, 101, 3218, 11120, 11123, 117, 229, 3237, 256, 59, 99, 3224, 11128, 256, 59, 101, 3218, 11133, 241, 3224, 512, 65, 97, 105, 116, 11144, 11147, 11165, 11175, 114, 242, 10632, 114, 114, 384, 59, 99, 119, 11156, 11157, 11161, 24987, 59, 49152, 10547, 824, 59, 49152, 8605, 824, 103, 104, 116, 97, 114, 114, 111, 119, 187, 11157, 114, 105, 256, 59, 101, 3275, 3286, 896, 99, 104, 105, 109, 112, 113, 117, 11197, 11213, 11225, 11012, 2936, 11236, 11247, 512, 59, 99, 101, 114, 3378, 11206, 3383, 11209, 117, 229, 3397, 59, 49152, 55349, 56515, 111, 114, 116, 621, 11013, 0, 0, 11222, 97, 114, 225, 11094, 109, 256, 59, 101, 3438, 11231, 256, 59, 113, 3444, 3443, 115, 117, 256, 98, 112, 11243, 11245, 229, 3320, 229, 3339, 384, 98, 99, 112, 11254, 11281, 11289, 512, 59, 69, 101, 115, 11263, 11264, 3362, 11268, 25220, 59, 49152, 10949, 824, 101, 116, 256, 59, 101, 3355, 11275, 113, 256, 59, 113, 3363, 11264, 99, 256, 59, 101, 3378, 11287, 241, 3384, 512, 59, 69, 101, 115, 11298, 11299, 3423, 11303, 25221, 59, 49152, 10950, 824, 101, 116, 256, 59, 101, 3416, 11310, 113, 256, 59, 113, 3424, 11299, 512, 103, 105, 108, 114, 11325, 11327, 11333, 11335, 236, 3031, 108, 100, 101, 32827, 241, 16625, 231, 3139, 105, 97, 110, 103, 108, 101, 256, 108, 114, 11346, 11356, 101, 102, 116, 256, 59, 101, 3098, 11354, 241, 3110, 105, 103, 104, 116, 256, 59, 101, 3275, 11365, 241, 3287, 256, 59, 109, 11372, 11373, 17341, 384, 59, 101, 115, 11380, 11381, 11385, 16419, 114, 111, 59, 24854, 112, 59, 24583, 1152, 68, 72, 97, 100, 103, 105, 108, 114, 115, 11407, 11412, 11417, 11422, 11427, 11440, 11446, 11475, 11491, 97, 115, 104, 59, 25261, 97, 114, 114, 59, 26884, 112, 59, 49152, 8781, 8402, 97, 115, 104, 59, 25260, 256, 101, 116, 11432, 11436, 59, 49152, 8805, 8402, 59, 49152, 62, 8402, 110, 102, 105, 110, 59, 27102, 384, 65, 101, 116, 11453, 11457, 11461, 114, 114, 59, 26882, 59, 49152, 8804, 8402, 256, 59, 114, 11466, 11469, 49152, 60, 8402, 105, 101, 59, 49152, 8884, 8402, 256, 65, 116, 11480, 11484, 114, 114, 59, 26883, 114, 105, 101, 59, 49152, 8885, 8402, 105, 109, 59, 49152, 8764, 8402, 384, 65, 97, 110, 11504, 11508, 11522, 114, 114, 59, 25046, 114, 256, 104, 114, 11514, 11517, 107, 59, 26915, 256, 59, 111, 5095, 5093, 101, 97, 114, 59, 26919, 4691, 6805, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11565, 0, 11576, 11592, 11616, 11621, 11634, 11652, 6919, 0, 0, 11661, 11691, 0, 11720, 11726, 0, 11740, 11801, 11819, 11838, 11843, 256, 99, 115, 11569, 6807, 117, 116, 101, 32827, 243, 16627, 256, 105, 121, 11580, 11589, 114, 256, 59, 99, 6814, 11586, 32827, 244, 16628, 59, 17470, 640, 97, 98, 105, 111, 115, 6816, 11602, 11607, 456, 11610, 108, 97, 99, 59, 16721, 118, 59, 27192, 111, 108, 100, 59, 27068, 108, 105, 103, 59, 16723, 256, 99, 114, 11625, 11629, 105, 114, 59, 27071, 59, 49152, 55349, 56620, 879, 11641, 0, 0, 11644, 0, 11650, 110, 59, 17115, 97, 118, 101, 32827, 242, 16626, 59, 27073, 256, 98, 109, 11656, 3572, 97, 114, 59, 27061, 512, 97, 99, 105, 116, 11669, 11672, 11685, 11688, 114, 242, 6784, 256, 105, 114, 11677, 11680, 114, 59, 27070, 111, 115, 115, 59, 27067, 110, 229, 3666, 59, 27072, 384, 97, 101, 105, 11697, 11701, 11705, 99, 114, 59, 16717, 103, 97, 59, 17353, 384, 99, 100, 110, 11712, 11717, 461, 114, 111, 110, 59, 17343, 59, 27062, 112, 102, 59, 49152, 55349, 56672, 384, 97, 101, 108, 11732, 11735, 466, 114, 59, 27063, 114, 112, 59, 27065, 896, 59, 97, 100, 105, 111, 115, 118, 11754, 11755, 11758, 11784, 11789, 11792, 11798, 25128, 114, 242, 6790, 512, 59, 101, 102, 109, 11767, 11768, 11778, 11781, 27229, 114, 256, 59, 111, 11774, 11775, 24884, 102, 187, 11775, 32827, 170, 16554, 32827, 186, 16570, 103, 111, 102, 59, 25270, 114, 59, 27222, 108, 111, 112, 101, 59, 27223, 59, 27227, 384, 99, 108, 111, 11807, 11809, 11815, 242, 11777, 97, 115, 104, 32827, 248, 16632, 108, 59, 25240, 105, 364, 11823, 11828, 100, 101, 32827, 245, 16629, 101, 115, 256, 59, 97, 475, 11834, 115, 59, 27190, 109, 108, 32827, 246, 16630, 98, 97, 114, 59, 25405, 2785, 11870, 0, 11901, 0, 11904, 11933, 0, 11938, 11961, 0, 0, 11979, 3740, 0, 12051, 0, 0, 12075, 12220, 0, 12232, 114, 512, 59, 97, 115, 116, 1027, 11879, 11890, 3717, 33024, 182, 59, 108, 11885, 11886, 16566, 108, 101, 236, 1027, 617, 11896, 0, 0, 11899, 109, 59, 27379, 59, 27389, 121, 59, 17471, 114, 640, 99, 105, 109, 112, 116, 11915, 11919, 11923, 6245, 11927, 110, 116, 59, 16421, 111, 100, 59, 16430, 105, 108, 59, 24624, 101, 110, 107, 59, 24625, 114, 59, 49152, 55349, 56621, 384, 105, 109, 111, 11944, 11952, 11956, 256, 59, 118, 11949, 11950, 17350, 59, 17365, 109, 97, 244, 2678, 110, 101, 59, 26126, 384, 59, 116, 118, 11967, 11968, 11976, 17344, 99, 104, 102, 111, 114, 107, 187, 8189, 59, 17366, 256, 97, 117, 11983, 11999, 110, 256, 99, 107, 11989, 11997, 107, 256, 59, 104, 8692, 11995, 59, 24846, 246, 8692, 115, 1152, 59, 97, 98, 99, 100, 101, 109, 115, 116, 12019, 12020, 6408, 12025, 12029, 12036, 12038, 12042, 12046, 16427, 99, 105, 114, 59, 27171, 105, 114, 59, 27170, 256, 111, 117, 7488, 12034, 59, 27173, 59, 27250, 110, 32955, 177, 3741, 105, 109, 59, 27174, 119, 111, 59, 27175, 384, 105, 112, 117, 12057, 12064, 12069, 110, 116, 105, 110, 116, 59, 27157, 102, 59, 49152, 55349, 56673, 110, 100, 32827, 163, 16547, 1280, 59, 69, 97, 99, 101, 105, 110, 111, 115, 117, 3784, 12095, 12097, 12100, 12103, 12161, 12169, 12178, 12158, 12214, 59, 27315, 112, 59, 27319, 117, 229, 3801, 256, 59, 99, 3790, 12108, 768, 59, 97, 99, 101, 110, 115, 3784, 12121, 12127, 12134, 12136, 12158, 112, 112, 114, 111, 248, 12099, 117, 114, 108, 121, 101, 241, 3801, 241, 3790, 384, 97, 101, 115, 12143, 12150, 12154, 112, 112, 114, 111, 120, 59, 27321, 113, 113, 59, 27317, 105, 109, 59, 25320, 105, 237, 3807, 109, 101, 256, 59, 115, 12168, 3758, 24626, 384, 69, 97, 115, 12152, 12176, 12154, 240, 12149, 384, 100, 102, 112, 3820, 12185, 12207, 384, 97, 108, 115, 12192, 12197, 12202, 108, 97, 114, 59, 25390, 105, 110, 101, 59, 25362, 117, 114, 102, 59, 25363, 256, 59, 116, 3835, 12212, 239, 3835, 114, 101, 108, 59, 25264, 256, 99, 105, 12224, 12229, 114, 59, 49152, 55349, 56517, 59, 17352, 110, 99, 115, 112, 59, 24584, 768, 102, 105, 111, 112, 115, 117, 12250, 8930, 12255, 12261, 12267, 12273, 114, 59, 49152, 55349, 56622, 112, 102, 59, 49152, 55349, 56674, 114, 105, 109, 101, 59, 24663, 99, 114, 59, 49152, 55349, 56518, 384, 97, 101, 111, 12280, 12297, 12307, 116, 256, 101, 105, 12286, 12293, 114, 110, 105, 111, 110, 243, 1712, 110, 116, 59, 27158, 115, 116, 256, 59, 101, 12304, 12305, 16447, 241, 7961, 244, 3860, 2688, 65, 66, 72, 97, 98, 99, 100, 101, 102, 104, 105, 108, 109, 110, 111, 112, 114, 115, 116, 117, 120, 12352, 12369, 12373, 12377, 12512, 12558, 12587, 12615, 12642, 12658, 12686, 12806, 12821, 12836, 12841, 12888, 12910, 12914, 12944, 12976, 12983, 384, 97, 114, 116, 12359, 12362, 12364, 114, 242, 4275, 242, 989, 97, 105, 108, 59, 26908, 97, 114, 242, 7269, 97, 114, 59, 26980, 896, 99, 100, 101, 110, 113, 114, 116, 12392, 12405, 12408, 12415, 12431, 12436, 12492, 256, 101, 117, 12397, 12401, 59, 49152, 8765, 817, 116, 101, 59, 16725, 105, 227, 4462, 109, 112, 116, 121, 118, 59, 27059, 103, 512, 59, 100, 101, 108, 4049, 12425, 12427, 12429, 59, 27026, 59, 27045, 229, 4049, 117, 111, 32827, 187, 16571, 114, 1408, 59, 97, 98, 99, 102, 104, 108, 112, 115, 116, 119, 4060, 12460, 12463, 12471, 12473, 12476, 12478, 12480, 12483, 12487, 12490, 112, 59, 26997, 256, 59, 102, 4064, 12468, 115, 59, 26912, 59, 26931, 115, 59, 26910, 235, 8797, 240, 10030, 108, 59, 26949, 105, 109, 59, 26996, 108, 59, 24995, 59, 24989, 256, 97, 105, 12497, 12501, 105, 108, 59, 26906, 111, 256, 59, 110, 12507, 12508, 25142, 97, 108, 243, 3870, 384, 97, 98, 114, 12519, 12522, 12526, 114, 242, 6117, 114, 107, 59, 26483, 256, 97, 107, 12531, 12541, 99, 256, 101, 107, 12537, 12539, 59, 16509, 59, 16477, 256, 101, 115, 12546, 12548, 59, 27020, 108, 256, 100, 117, 12554, 12556, 59, 27022, 59, 27024, 512, 97, 101, 117, 121, 12567, 12572, 12583, 12585, 114, 111, 110, 59, 16729, 256, 100, 105, 12577, 12581, 105, 108, 59, 16727, 236, 4082, 226, 12538, 59, 17472, 512, 99, 108, 113, 115, 12596, 12599, 12605, 12612, 97, 59, 26935, 100, 104, 97, 114, 59, 26985, 117, 111, 256, 59, 114, 526, 525, 104, 59, 25011, 384, 97, 99, 103, 12622, 12639, 3908, 108, 512, 59, 105, 112, 115, 3960, 12632, 12635, 4252, 110, 229, 4283, 97, 114, 244, 4009, 116, 59, 26029, 384, 105, 108, 114, 12649, 4131, 12654, 115, 104, 116, 59, 27005, 59, 49152, 55349, 56623, 256, 97, 111, 12663, 12678, 114, 256, 100, 117, 12669, 12671, 187, 1147, 256, 59, 108, 4241, 12676, 59, 26988, 256, 59, 118, 12683, 12684, 17345, 59, 17393, 384, 103, 110, 115, 12693, 12793, 12796, 104, 116, 768, 97, 104, 108, 114, 115, 116, 12708, 12720, 12738, 12760, 12772, 12782, 114, 114, 111, 119, 256, 59, 116, 4060, 12717, 97, 233, 12488, 97, 114, 112, 111, 111, 110, 256, 100, 117, 12731, 12735, 111, 119, 238, 12670, 112, 187, 4242, 101, 102, 116, 256, 97, 104, 12746, 12752, 114, 114, 111, 119, 243, 4074, 97, 114, 112, 111, 111, 110, 243, 1361, 105, 103, 104, 116, 97, 114, 114, 111, 119, 115, 59, 25033, 113, 117, 105, 103, 97, 114, 114, 111, 247, 12491, 104, 114, 101, 101, 116, 105, 109, 101, 115, 59, 25292, 103, 59, 17114, 105, 110, 103, 100, 111, 116, 115, 101, 241, 7986, 384, 97, 104, 109, 12813, 12816, 12819, 114, 242, 4074, 97, 242, 1361, 59, 24591, 111, 117, 115, 116, 256, 59, 97, 12830, 12831, 25521, 99, 104, 101, 187, 12831, 109, 105, 100, 59, 27374, 512, 97, 98, 112, 116, 12850, 12861, 12864, 12882, 256, 110, 114, 12855, 12858, 103, 59, 26605, 114, 59, 25086, 114, 235, 4099, 384, 97, 102, 108, 12871, 12874, 12878, 114, 59, 27014, 59, 49152, 55349, 56675, 117, 115, 59, 27182, 105, 109, 101, 115, 59, 27189, 256, 97, 112, 12893, 12903, 114, 256, 59, 103, 12899, 12900, 16425, 116, 59, 27028, 111, 108, 105, 110, 116, 59, 27154, 97, 114, 242, 12771, 512, 97, 99, 104, 113, 12923, 12928, 4284, 12933, 113, 117, 111, 59, 24634, 114, 59, 49152, 55349, 56519, 256, 98, 117, 12539, 12938, 111, 256, 59, 114, 532, 531, 384, 104, 105, 114, 12951, 12955, 12960, 114, 101, 229, 12792, 109, 101, 115, 59, 25290, 105, 512, 59, 101, 102, 108, 12970, 4185, 6177, 12971, 26041, 116, 114, 105, 59, 27086, 108, 117, 104, 97, 114, 59, 26984, 59, 24862, 3425, 13013, 13019, 13023, 13100, 13112, 13169, 0, 13178, 13220, 0, 0, 13292, 13296, 0, 13352, 13384, 13402, 13485, 13489, 13514, 13553, 0, 13846, 0, 0, 13875, 99, 117, 116, 101, 59, 16731, 113, 117, 239, 10170, 1280, 59, 69, 97, 99, 101, 105, 110, 112, 115, 121, 4589, 13043, 13045, 13055, 13058, 13067, 13071, 13087, 13094, 13097, 59, 27316, 496, 13050, 0, 13052, 59, 27320, 111, 110, 59, 16737, 117, 229, 4606, 256, 59, 100, 4595, 13063, 105, 108, 59, 16735, 114, 99, 59, 16733, 384, 69, 97, 115, 13078, 13080, 13083, 59, 27318, 112, 59, 27322, 105, 109, 59, 25321, 111, 108, 105, 110, 116, 59, 27155, 105, 237, 4612, 59, 17473, 111, 116, 384, 59, 98, 101, 13108, 7495, 13109, 25285, 59, 27238, 896, 65, 97, 99, 109, 115, 116, 120, 13126, 13130, 13143, 13147, 13150, 13155, 13165, 114, 114, 59, 25048, 114, 256, 104, 114, 13136, 13138, 235, 8744, 256, 59, 111, 2614, 2612, 116, 32827, 167, 16551, 105, 59, 16443, 119, 97, 114, 59, 26921, 109, 256, 105, 110, 13161, 240, 110, 117, 243, 241, 116, 59, 26422, 114, 256, 59, 111, 13174, 8277, 49152, 55349, 56624, 512, 97, 99, 111, 121, 13186, 13190, 13201, 13216, 114, 112, 59, 26223, 256, 104, 121, 13195, 13199, 99, 121, 59, 17481, 59, 17480, 114, 116, 621, 13209, 0, 0, 13212, 105, 228, 5220, 97, 114, 97, 236, 11887, 32827, 173, 16557, 256, 103, 109, 13224, 13236, 109, 97, 384, 59, 102, 118, 13233, 13234, 13234, 17347, 59, 17346, 1024, 59, 100, 101, 103, 108, 110, 112, 114, 4779, 13253, 13257, 13262, 13270, 13278, 13281, 13286, 111, 116, 59, 27242, 256, 59, 113, 4785, 4784, 256, 59, 69, 13267, 13268, 27294, 59, 27296, 256, 59, 69, 13275, 13276, 27293, 59, 27295, 101, 59, 25158, 108, 117, 115, 59, 27172, 97, 114, 114, 59, 26994, 97, 114, 242, 4413, 512, 97, 101, 105, 116, 13304, 13320, 13327, 13335, 256, 108, 115, 13309, 13316, 108, 115, 101, 116, 109, 233, 13162, 104, 112, 59, 27187, 112, 97, 114, 115, 108, 59, 27108, 256, 100, 108, 5219, 13332, 101, 59, 25379, 256, 59, 101, 13340, 13341, 27306, 256, 59, 115, 13346, 13347, 27308, 59, 49152, 10924, 65024, 384, 102, 108, 112, 13358, 13363, 13378, 116, 99, 121, 59, 17484, 256, 59, 98, 13368, 13369, 16431, 256, 59, 97, 13374, 13375, 27076, 114, 59, 25407, 102, 59, 49152, 55349, 56676, 97, 256, 100, 114, 13389, 1026, 101, 115, 256, 59, 117, 13396, 13397, 26208, 105, 116, 187, 13397, 384, 99, 115, 117, 13408, 13433, 13471, 256, 97, 117, 13413, 13423, 112, 256, 59, 115, 4488, 13419, 59, 49152, 8851, 65024, 112, 256, 59, 115, 4532, 13429, 59, 49152, 8852, 65024, 117, 256, 98, 112, 13439, 13455, 384, 59, 101, 115, 4503, 4508, 13446, 101, 116, 256, 59, 101, 4503, 13453, 241, 4509, 384, 59, 101, 115, 4520, 4525, 13462, 101, 116, 256, 59, 101, 4520, 13469, 241, 4526, 384, 59, 97, 102, 4475, 13478, 1456, 114, 357, 13483, 1457, 187, 4476, 97, 114, 242, 4424, 512, 99, 101, 109, 116, 13497, 13502, 13506, 13509, 114, 59, 49152, 55349, 56520, 116, 109, 238, 241, 105, 236, 13333, 97, 114, 230, 4542, 256, 97, 114, 13518, 13525, 114, 256, 59, 102, 13524, 6079, 26118, 256, 97, 110, 13530, 13549, 105, 103, 104, 116, 256, 101, 112, 13539, 13546, 112, 115, 105, 108, 111, 238, 7904, 104, 233, 11951, 115, 187, 10322, 640, 98, 99, 109, 110, 112, 13563, 13662, 4617, 13707, 13710, 1152, 59, 69, 100, 101, 109, 110, 112, 114, 115, 13582, 13583, 13585, 13589, 13598, 13603, 13612, 13617, 13622, 25218, 59, 27333, 111, 116, 59, 27325, 256, 59, 100, 4570, 13594, 111, 116, 59, 27331, 117, 108, 116, 59, 27329, 256, 69, 101, 13608, 13610, 59, 27339, 59, 25226, 108, 117, 115, 59, 27327, 97, 114, 114, 59, 27001, 384, 101, 105, 117, 13629, 13650, 13653, 116, 384, 59, 101, 110, 13582, 13637, 13643, 113, 256, 59, 113, 4570, 13583, 101, 113, 256, 59, 113, 13611, 13608, 109, 59, 27335, 256, 98, 112, 13658, 13660, 59, 27349, 59, 27347, 99, 768, 59, 97, 99, 101, 110, 115, 4589, 13676, 13682, 13689, 13691, 13094, 112, 112, 114, 111, 248, 13050, 117, 114, 108, 121, 101, 241, 4606, 241, 4595, 384, 97, 101, 115, 13698, 13704, 13083, 112, 112, 114, 111, 248, 13082, 113, 241, 13079, 103, 59, 26218, 1664, 49, 50, 51, 59, 69, 100, 101, 104, 108, 109, 110, 112, 115, 13737, 13740, 13743, 4636, 13746, 13748, 13760, 13769, 13781, 13786, 13791, 13800, 13805, 32827, 185, 16569, 32827, 178, 16562, 32827, 179, 16563, 59, 27334, 256, 111, 115, 13753, 13756, 116, 59, 27326, 117, 98, 59, 27352, 256, 59, 100, 4642, 13765, 111, 116, 59, 27332, 115, 256, 111, 117, 13775, 13778, 108, 59, 26569, 98, 59, 27351, 97, 114, 114, 59, 27003, 117, 108, 116, 59, 27330, 256, 69, 101, 13796, 13798, 59, 27340, 59, 25227, 108, 117, 115, 59, 27328, 384, 101, 105, 117, 13812, 13833, 13836, 116, 384, 59, 101, 110, 4636, 13820, 13826, 113, 256, 59, 113, 4642, 13746, 101, 113, 256, 59, 113, 13799, 13796, 109, 59, 27336, 256, 98, 112, 13841, 13843, 59, 27348, 59, 27350, 384, 65, 97, 110, 13852, 13856, 13869, 114, 114, 59, 25049, 114, 256, 104, 114, 13862, 13864, 235, 8750, 256, 59, 111, 2603, 2601, 119, 97, 114, 59, 26922, 108, 105, 103, 32827, 223, 16607, 3041, 13905, 13917, 13920, 4814, 13939, 13945, 0, 13950, 14018, 0, 0, 0, 0, 0, 14043, 14083, 0, 14089, 14188, 0, 0, 0, 14215, 626, 13910, 0, 0, 13915, 103, 101, 116, 59, 25366, 59, 17348, 114, 235, 3679, 384, 97, 101, 121, 13926, 13931, 13936, 114, 111, 110, 59, 16741, 100, 105, 108, 59, 16739, 59, 17474, 108, 114, 101, 99, 59, 25365, 114, 59, 49152, 55349, 56625, 512, 101, 105, 107, 111, 13958, 13981, 14005, 14012, 498, 13963, 0, 13969, 101, 256, 52, 102, 4740, 4737, 97, 384, 59, 115, 118, 13976, 13977, 13979, 17336, 121, 109, 59, 17361, 256, 99, 110, 13986, 14002, 107, 256, 97, 115, 13992, 13998, 112, 112, 114, 111, 248, 4801, 105, 109, 187, 4780, 115, 240, 4766, 256, 97, 115, 14010, 13998, 240, 4801, 114, 110, 32827, 254, 16638, 492, 799, 14022, 8935, 101, 115, 33152, 215, 59, 98, 100, 14031, 14032, 14040, 16599, 256, 59, 97, 6415, 14037, 114, 59, 27185, 59, 27184, 384, 101, 112, 115, 14049, 14051, 14080, 225, 10829, 512, 59, 98, 99, 102, 1158, 14060, 14064, 14068, 111, 116, 59, 25398, 105, 114, 59, 27377, 256, 59, 111, 14073, 14076, 49152, 55349, 56677, 114, 107, 59, 27354, 225, 13154, 114, 105, 109, 101, 59, 24628, 384, 97, 105, 112, 14095, 14098, 14180, 100, 229, 4680, 896, 97, 100, 101, 109, 112, 115, 116, 14113, 14157, 14144, 14161, 14167, 14172, 14175, 110, 103, 108, 101, 640, 59, 100, 108, 113, 114, 14128, 14129, 14134, 14144, 14146, 26037, 111, 119, 110, 187, 7611, 101, 102, 116, 256, 59, 101, 10240, 14142, 241, 2350, 59, 25180, 105, 103, 104, 116, 256, 59, 101, 12970, 14155, 241, 4186, 111, 116, 59, 26092, 105, 110, 117, 115, 59, 27194, 108, 117, 115, 59, 27193, 98, 59, 27085, 105, 109, 101, 59, 27195, 101, 122, 105, 117, 109, 59, 25570, 384, 99, 104, 116, 14194, 14205, 14209, 256, 114, 121, 14199, 14203, 59, 49152, 55349, 56521, 59, 17478, 99, 121, 59, 17499, 114, 111, 107, 59, 16743, 256, 105, 111, 14219, 14222, 120, 244, 6007, 104, 101, 97, 100, 256, 108, 114, 14231, 14240, 101, 102, 116, 97, 114, 114, 111, 247, 2127, 105, 103, 104, 116, 97, 114, 114, 111, 119, 187, 3933, 2304, 65, 72, 97, 98, 99, 100, 102, 103, 104, 108, 109, 111, 112, 114, 115, 116, 117, 119, 14288, 14291, 14295, 14308, 14320, 14332, 14350, 14364, 14371, 14388, 14417, 14429, 14443, 14505, 14540, 14546, 14570, 14582, 114, 242, 1005, 97, 114, 59, 26979, 256, 99, 114, 14300, 14306, 117, 116, 101, 32827, 250, 16634, 242, 4432, 114, 483, 14314, 0, 14317, 121, 59, 17502, 118, 101, 59, 16749, 256, 105, 121, 14325, 14330, 114, 99, 32827, 251, 16635, 59, 17475, 384, 97, 98, 104, 14339, 14342, 14347, 114, 242, 5037, 108, 97, 99, 59, 16753, 97, 242, 5059, 256, 105, 114, 14355, 14360, 115, 104, 116, 59, 27006, 59, 49152, 55349, 56626, 114, 97, 118, 101, 32827, 249, 16633, 353, 14375, 14385, 114, 256, 108, 114, 14380, 14382, 187, 2391, 187, 4227, 108, 107, 59, 25984, 256, 99, 116, 14393, 14413, 623, 14399, 0, 0, 14410, 114, 110, 256, 59, 101, 14405, 14406, 25372, 114, 187, 14406, 111, 112, 59, 25359, 114, 105, 59, 26104, 256, 97, 108, 14422, 14426, 99, 114, 59, 16747, 32955, 168, 841, 256, 103, 112, 14434, 14438, 111, 110, 59, 16755, 102, 59, 49152, 55349, 56678, 768, 97, 100, 104, 108, 115, 117, 4427, 14456, 14461, 4978, 14481, 14496, 111, 119, 110, 225, 5043, 97, 114, 112, 111, 111, 110, 256, 108, 114, 14472, 14476, 101, 102, 244, 14381, 105, 103, 104, 244, 14383, 105, 384, 59, 104, 108, 14489, 14490, 14492, 17349, 187, 5114, 111, 110, 187, 14490, 112, 97, 114, 114, 111, 119, 115, 59, 25032, 384, 99, 105, 116, 14512, 14532, 14536, 623, 14518, 0, 0, 14529, 114, 110, 256, 59, 101, 14524, 14525, 25373, 114, 187, 14525, 111, 112, 59, 25358, 110, 103, 59, 16751, 114, 105, 59, 26105, 99, 114, 59, 49152, 55349, 56522, 384, 100, 105, 114, 14553, 14557, 14562, 111, 116, 59, 25328, 108, 100, 101, 59, 16745, 105, 256, 59, 102, 14128, 14568, 187, 6163, 256, 97, 109, 14575, 14578, 114, 242, 14504, 108, 32827, 252, 16636, 97, 110, 103, 108, 101, 59, 27047, 1920, 65, 66, 68, 97, 99, 100, 101, 102, 108, 110, 111, 112, 114, 115, 122, 14620, 14623, 14633, 14637, 14773, 14776, 14781, 14815, 14820, 14824, 14835, 14841, 14845, 14849, 14880, 114, 242, 1015, 97, 114, 256, 59, 118, 14630, 14631, 27368, 59, 27369, 97, 115, 232, 993, 256, 110, 114, 14642, 14647, 103, 114, 116, 59, 27036, 896, 101, 107, 110, 112, 114, 115, 116, 13539, 14662, 14667, 14674, 14685, 14692, 14742, 97, 112, 112, 225, 9237, 111, 116, 104, 105, 110, 231, 7830, 384, 104, 105, 114, 13547, 11976, 14681, 111, 112, 244, 12213, 256, 59, 104, 5047, 14690, 239, 12685, 256, 105, 117, 14697, 14701, 103, 109, 225, 13235, 256, 98, 112, 14706, 14724, 115, 101, 116, 110, 101, 113, 256, 59, 113, 14717, 14720, 49152, 8842, 65024, 59, 49152, 10955, 65024, 115, 101, 116, 110, 101, 113, 256, 59, 113, 14735, 14738, 49152, 8843, 65024, 59, 49152, 10956, 65024, 256, 104, 114, 14747, 14751, 101, 116, 225, 13980, 105, 97, 110, 103, 108, 101, 256, 108, 114, 14762, 14767, 101, 102, 116, 187, 2341, 105, 103, 104, 116, 187, 4177, 121, 59, 17458, 97, 115, 104, 187, 4150, 384, 101, 108, 114, 14788, 14802, 14807, 384, 59, 98, 101, 11754, 14795, 14799, 97, 114, 59, 25275, 113, 59, 25178, 108, 105, 112, 59, 25326, 256, 98, 116, 14812, 5224, 97, 242, 5225, 114, 59, 49152, 55349, 56627, 116, 114, 233, 14766, 115, 117, 256, 98, 112, 14831, 14833, 187, 3356, 187, 3417, 112, 102, 59, 49152, 55349, 56679, 114, 111, 240, 3835, 116, 114, 233, 14772, 256, 99, 117, 14854, 14859, 114, 59, 49152, 55349, 56523, 256, 98, 112, 14864, 14872, 110, 256, 69, 101, 14720, 14870, 187, 14718, 110, 256, 69, 101, 14738, 14878, 187, 14736, 105, 103, 122, 97, 103, 59, 27034, 896, 99, 101, 102, 111, 112, 114, 115, 14902, 14907, 14934, 14939, 14932, 14945, 14954, 105, 114, 99, 59, 16757, 256, 100, 105, 14912, 14929, 256, 98, 103, 14917, 14921, 97, 114, 59, 27231, 101, 256, 59, 113, 5626, 14927, 59, 25177, 101, 114, 112, 59, 24856, 114, 59, 49152, 55349, 56628, 112, 102, 59, 49152, 55349, 56680, 256, 59, 101, 5241, 14950, 97, 116, 232, 5241, 99, 114, 59, 49152, 55349, 56524, 2787, 6030, 14983, 0, 14987, 0, 14992, 15003, 0, 0, 15005, 15016, 15019, 15023, 0, 0, 15043, 15054, 0, 15064, 6108, 6111, 116, 114, 233, 6097, 114, 59, 49152, 55349, 56629, 256, 65, 97, 14996, 14999, 114, 242, 963, 114, 242, 2550, 59, 17342, 256, 65, 97, 15009, 15012, 114, 242, 952, 114, 242, 2539, 97, 240, 10003, 105, 115, 59, 25339, 384, 100, 112, 116, 6052, 15029, 15038, 256, 102, 108, 15034, 6057, 59, 49152, 55349, 56681, 105, 109, 229, 6066, 256, 65, 97, 15047, 15050, 114, 242, 974, 114, 242, 2561, 256, 99, 113, 15058, 6072, 114, 59, 49152, 55349, 56525, 256, 112, 116, 6102, 15068, 114, 233, 6100, 1024, 97, 99, 101, 102, 105, 111, 115, 117, 15088, 15101, 15112, 15116, 15121, 15125, 15131, 15137, 99, 256, 117, 121, 15094, 15099, 116, 101, 32827, 253, 16637, 59, 17487, 256, 105, 121, 15106, 15110, 114, 99, 59, 16759, 59, 17483, 110, 32827, 165, 16549, 114, 59, 49152, 55349, 56630, 99, 121, 59, 17495, 112, 102, 59, 49152, 55349, 56682, 99, 114, 59, 49152, 55349, 56526, 256, 99, 109, 15142, 15145, 121, 59, 17486, 108, 32827, 255, 16639, 1280, 97, 99, 100, 101, 102, 104, 105, 111, 115, 119, 15170, 15176, 15188, 15192, 15204, 15209, 15213, 15220, 15226, 15232, 99, 117, 116, 101, 59, 16762, 256, 97, 121, 15181, 15186, 114, 111, 110, 59, 16766, 59, 17463, 111, 116, 59, 16764, 256, 101, 116, 15197, 15201, 116, 114, 230, 5471, 97, 59, 17334, 114, 59, 49152, 55349, 56631, 99, 121, 59, 17462, 103, 114, 97, 114, 114, 59, 25053, 112, 102, 59, 49152, 55349, 56683, 99, 114, 59, 49152, 55349, 56527, 256, 106, 110, 15237, 15239, 59, 24589, 106, 59, 24588]);

    // Generated using scripts/write-decode-map.ts
    // prettier-ignore
    var xmlDecodeTree = new Uint16Array([512, 97, 103, 108, 113, 9, 21, 24, 27, 621, 15, 0, 0, 18, 112, 59, 16422, 111, 115, 59, 16423, 116, 59, 16446, 116, 59, 16444, 117, 111, 116, 59, 16418]);

    // Adapted from https://github.com/mathiasbynens/he/blob/36afe179392226cf1b6ccdb16ebbb7a5a844d93a/src/he.js#L106-L134
    var _a;
    const decodeMap = new Map([
        [0, 65533],
        [128, 8364],
        [130, 8218],
        [131, 402],
        [132, 8222],
        [133, 8230],
        [134, 8224],
        [135, 8225],
        [136, 710],
        [137, 8240],
        [138, 352],
        [139, 8249],
        [140, 338],
        [142, 381],
        [145, 8216],
        [146, 8217],
        [147, 8220],
        [148, 8221],
        [149, 8226],
        [150, 8211],
        [151, 8212],
        [152, 732],
        [153, 8482],
        [154, 353],
        [155, 8250],
        [156, 339],
        [158, 382],
        [159, 376],
    ]);
    const fromCodePoint = 
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, node/no-unsupported-features/es-builtins
    (_a = String.fromCodePoint) !== null && _a !== void 0 ? _a : function (codePoint) {
        let output = "";
        if (codePoint > 0xffff) {
            codePoint -= 0x10000;
            output += String.fromCharCode(((codePoint >>> 10) & 0x3ff) | 0xd800);
            codePoint = 0xdc00 | (codePoint & 0x3ff);
        }
        output += String.fromCharCode(codePoint);
        return output;
    };
    function replaceCodePoint(codePoint) {
        var _a;
        if ((codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint > 0x10ffff) {
            return 0xfffd;
        }
        return (_a = decodeMap.get(codePoint)) !== null && _a !== void 0 ? _a : codePoint;
    }

    var CharCodes$1;
    (function (CharCodes) {
        CharCodes[CharCodes["NUM"] = 35] = "NUM";
        CharCodes[CharCodes["SEMI"] = 59] = "SEMI";
        CharCodes[CharCodes["ZERO"] = 48] = "ZERO";
        CharCodes[CharCodes["NINE"] = 57] = "NINE";
        CharCodes[CharCodes["LOWER_A"] = 97] = "LOWER_A";
        CharCodes[CharCodes["LOWER_F"] = 102] = "LOWER_F";
        CharCodes[CharCodes["LOWER_X"] = 120] = "LOWER_X";
        /** Bit that needs to be set to convert an upper case ASCII character to lower case */
        CharCodes[CharCodes["To_LOWER_BIT"] = 32] = "To_LOWER_BIT";
    })(CharCodes$1 || (CharCodes$1 = {}));
    var BinTrieFlags;
    (function (BinTrieFlags) {
        BinTrieFlags[BinTrieFlags["VALUE_LENGTH"] = 49152] = "VALUE_LENGTH";
        BinTrieFlags[BinTrieFlags["BRANCH_LENGTH"] = 16256] = "BRANCH_LENGTH";
        BinTrieFlags[BinTrieFlags["JUMP_TABLE"] = 127] = "JUMP_TABLE";
    })(BinTrieFlags || (BinTrieFlags = {}));
    function determineBranch(decodeTree, current, nodeIdx, char) {
        const branchCount = (current & BinTrieFlags.BRANCH_LENGTH) >> 7;
        const jumpOffset = current & BinTrieFlags.JUMP_TABLE;
        // Case 1: Single branch encoded in jump offset
        if (branchCount === 0) {
            return jumpOffset !== 0 && char === jumpOffset ? nodeIdx : -1;
        }
        // Case 2: Multiple branches encoded in jump table
        if (jumpOffset) {
            const value = char - jumpOffset;
            return value < 0 || value >= branchCount
                ? -1
                : decodeTree[nodeIdx + value] - 1;
        }
        // Case 3: Multiple branches encoded in dictionary
        // Binary search for the character.
        let lo = nodeIdx;
        let hi = lo + branchCount - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const midVal = decodeTree[mid];
            if (midVal < char) {
                lo = mid + 1;
            }
            else if (midVal > char) {
                hi = mid - 1;
            }
            else {
                return decodeTree[mid + branchCount];
            }
        }
        return -1;
    }

    const xmlReplacer = /["&'<>$\x80-\uFFFF]/g;
    const xmlCodeMap = new Map([
        [34, "&quot;"],
        [38, "&amp;"],
        [39, "&apos;"],
        [60, "&lt;"],
        [62, "&gt;"],
    ]);
    // For compatibility with node < 4, we wrap `codePointAt`
    const getCodePoint = 
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    String.prototype.codePointAt != null
        ? (str, index) => str.codePointAt(index)
        : // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
            (c, index) => (c.charCodeAt(index) & 0xfc00) === 0xd800
                ? (c.charCodeAt(index) - 0xd800) * 0x400 +
                    c.charCodeAt(index + 1) -
                    0xdc00 +
                    0x10000
                : c.charCodeAt(index);
    /**
     * Encodes all non-ASCII characters, as well as characters not valid in XML
     * documents using XML entities.
     *
     * If a character has no equivalent entity, a
     * numeric hexadecimal reference (eg. `&#xfc;`) will be used.
     */
    function encodeXML(str) {
        let ret = "";
        let lastIdx = 0;
        let match;
        while ((match = xmlReplacer.exec(str)) !== null) {
            const i = match.index;
            const char = str.charCodeAt(i);
            const next = xmlCodeMap.get(char);
            if (next !== undefined) {
                ret += str.substring(lastIdx, i) + next;
                lastIdx = i + 1;
            }
            else {
                ret += `${str.substring(lastIdx, i)}&#x${getCodePoint(str, i).toString(16)};`;
                // Increase by 1 if we have a surrogate pair
                lastIdx = xmlReplacer.lastIndex += Number((char & 0xfc00) === 0xd800);
            }
        }
        return ret + str.substr(lastIdx);
    }
    function getEscaper(regex, map) {
        return function escape(data) {
            let match;
            let lastIdx = 0;
            let result = "";
            while ((match = regex.exec(data))) {
                if (lastIdx !== match.index) {
                    result += data.substring(lastIdx, match.index);
                }
                // We know that this chararcter will be in the map.
                result += map.get(match[0].charCodeAt(0));
                // Every match will be of length 1
                lastIdx = match.index + 1;
            }
            return result + data.substring(lastIdx);
        };
    }
    /**
     * Encodes all characters that have to be escaped in HTML attributes,
     * following {@link https://html.spec.whatwg.org/multipage/parsing.html#escapingString}.
     *
     * @param data String to escape.
     */
    const escapeAttribute = getEscaper(/["&\u00A0]/g, new Map([
        [34, "&quot;"],
        [38, "&amp;"],
        [160, "&nbsp;"],
    ]));
    /**
     * Encodes all characters that have to be escaped in HTML text,
     * following {@link https://html.spec.whatwg.org/multipage/parsing.html#escapingString}.
     *
     * @param data String to escape.
     */
    const escapeText = getEscaper(/[&<>\u00A0]/g, new Map([
        [38, "&amp;"],
        [60, "&lt;"],
        [62, "&gt;"],
        [160, "&nbsp;"],
    ]));

    /** The level of entities to support. */
    var EntityLevel;
    (function (EntityLevel) {
        /** Support only XML entities. */
        EntityLevel[EntityLevel["XML"] = 0] = "XML";
        /** Support HTML entities, which are a superset of XML entities. */
        EntityLevel[EntityLevel["HTML"] = 1] = "HTML";
    })(EntityLevel || (EntityLevel = {}));
    /** Determines whether some entities are allowed to be written without a trailing `;`. */
    var DecodingMode;
    (function (DecodingMode) {
        /** Support legacy HTML entities. */
        DecodingMode[DecodingMode["Legacy"] = 0] = "Legacy";
        /** Do not support legacy HTML entities. */
        DecodingMode[DecodingMode["Strict"] = 1] = "Strict";
    })(DecodingMode || (DecodingMode = {}));
    var EncodingMode;
    (function (EncodingMode) {
        /**
         * The output is UTF-8 encoded. Only characters that need escaping within
         * XML will be escaped.
         */
        EncodingMode[EncodingMode["UTF8"] = 0] = "UTF8";
        /**
         * The output consists only of ASCII characters. Characters that need
         * escaping within HTML, and characters that aren't ASCII characters will
         * be escaped.
         */
        EncodingMode[EncodingMode["ASCII"] = 1] = "ASCII";
        /**
         * Encode all characters that have an equivalent entity, as well as all
         * characters that are not ASCII characters.
         */
        EncodingMode[EncodingMode["Extensive"] = 2] = "Extensive";
        /**
         * Encode all characters that have to be escaped in HTML attributes,
         * following {@link https://html.spec.whatwg.org/multipage/parsing.html#escapingString}.
         */
        EncodingMode[EncodingMode["Attribute"] = 3] = "Attribute";
        /**
         * Encode all characters that have to be escaped in HTML text,
         * following {@link https://html.spec.whatwg.org/multipage/parsing.html#escapingString}.
         */
        EncodingMode[EncodingMode["Text"] = 4] = "Text";
    })(EncodingMode || (EncodingMode = {}));

    const elementNames = new Map([
        "altGlyph",
        "altGlyphDef",
        "altGlyphItem",
        "animateColor",
        "animateMotion",
        "animateTransform",
        "clipPath",
        "feBlend",
        "feColorMatrix",
        "feComponentTransfer",
        "feComposite",
        "feConvolveMatrix",
        "feDiffuseLighting",
        "feDisplacementMap",
        "feDistantLight",
        "feDropShadow",
        "feFlood",
        "feFuncA",
        "feFuncB",
        "feFuncG",
        "feFuncR",
        "feGaussianBlur",
        "feImage",
        "feMerge",
        "feMergeNode",
        "feMorphology",
        "feOffset",
        "fePointLight",
        "feSpecularLighting",
        "feSpotLight",
        "feTile",
        "feTurbulence",
        "foreignObject",
        "glyphRef",
        "linearGradient",
        "radialGradient",
        "textPath",
    ].map((val) => [val.toLowerCase(), val]));
    const attributeNames = new Map([
        "definitionURL",
        "attributeName",
        "attributeType",
        "baseFrequency",
        "baseProfile",
        "calcMode",
        "clipPathUnits",
        "diffuseConstant",
        "edgeMode",
        "filterUnits",
        "glyphRef",
        "gradientTransform",
        "gradientUnits",
        "kernelMatrix",
        "kernelUnitLength",
        "keyPoints",
        "keySplines",
        "keyTimes",
        "lengthAdjust",
        "limitingConeAngle",
        "markerHeight",
        "markerUnits",
        "markerWidth",
        "maskContentUnits",
        "maskUnits",
        "numOctaves",
        "pathLength",
        "patternContentUnits",
        "patternTransform",
        "patternUnits",
        "pointsAtX",
        "pointsAtY",
        "pointsAtZ",
        "preserveAlpha",
        "preserveAspectRatio",
        "primitiveUnits",
        "refX",
        "refY",
        "repeatCount",
        "repeatDur",
        "requiredExtensions",
        "requiredFeatures",
        "specularConstant",
        "specularExponent",
        "spreadMethod",
        "startOffset",
        "stdDeviation",
        "stitchTiles",
        "surfaceScale",
        "systemLanguage",
        "tableValues",
        "targetX",
        "targetY",
        "textLength",
        "viewBox",
        "viewTarget",
        "xChannelSelector",
        "yChannelSelector",
        "zoomAndPan",
    ].map((val) => [val.toLowerCase(), val]));

    /*
     * Module dependencies
     */
    const unencodedElements = new Set([
        "style",
        "script",
        "xmp",
        "iframe",
        "noembed",
        "noframes",
        "plaintext",
        "noscript",
    ]);
    function replaceQuotes(value) {
        return value.replace(/"/g, "&quot;");
    }
    /**
     * Format attributes
     */
    function formatAttributes(attributes, opts) {
        var _a;
        if (!attributes)
            return;
        const encode = ((_a = opts.encodeEntities) !== null && _a !== void 0 ? _a : opts.decodeEntities) === false
            ? replaceQuotes
            : opts.xmlMode || opts.encodeEntities !== "utf8"
                ? encodeXML
                : escapeAttribute;
        return Object.keys(attributes)
            .map((key) => {
            var _a, _b;
            const value = (_a = attributes[key]) !== null && _a !== void 0 ? _a : "";
            if (opts.xmlMode === "foreign") {
                /* Fix up mixed-case attribute names */
                key = (_b = attributeNames.get(key)) !== null && _b !== void 0 ? _b : key;
            }
            if (!opts.emptyAttrs && !opts.xmlMode && value === "") {
                return key;
            }
            return `${key}="${encode(value)}"`;
        })
            .join(" ");
    }
    /**
     * Self-enclosing tags
     */
    const singleTag = new Set([
        "area",
        "base",
        "basefont",
        "br",
        "col",
        "command",
        "embed",
        "frame",
        "hr",
        "img",
        "input",
        "isindex",
        "keygen",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    ]);
    /**
     * Renders a DOM node or an array of DOM nodes to a string.
     *
     * Can be thought of as the equivalent of the `outerHTML` of the passed node(s).
     *
     * @param node Node to be rendered.
     * @param options Changes serialization behavior
     */
    function render$1(node, options = {}) {
        const nodes = "length" in node ? node : [node];
        let output = "";
        for (let i = 0; i < nodes.length; i++) {
            output += renderNode(nodes[i], options);
        }
        return output;
    }
    function renderNode(node, options) {
        switch (node.type) {
            case Root:
                return render$1(node.children, options);
            // @ts-expect-error We don't use `Doctype` yet
            case Doctype:
            case Directive:
                return renderDirective(node);
            case Comment$1:
                return renderComment(node);
            case CDATA$1:
                return renderCdata(node);
            case Script:
            case Style:
            case Tag:
                return renderTag(node, options);
            case Text$1:
                return renderText(node, options);
        }
    }
    const foreignModeIntegrationPoints = new Set([
        "mi",
        "mo",
        "mn",
        "ms",
        "mtext",
        "annotation-xml",
        "foreignObject",
        "desc",
        "title",
    ]);
    const foreignElements = new Set(["svg", "math"]);
    function renderTag(elem, opts) {
        var _a;
        // Handle SVG / MathML in HTML
        if (opts.xmlMode === "foreign") {
            /* Fix up mixed-case element names */
            elem.name = (_a = elementNames.get(elem.name)) !== null && _a !== void 0 ? _a : elem.name;
            /* Exit foreign mode at integration points */
            if (elem.parent &&
                foreignModeIntegrationPoints.has(elem.parent.name)) {
                opts = { ...opts, xmlMode: false };
            }
        }
        if (!opts.xmlMode && foreignElements.has(elem.name)) {
            opts = { ...opts, xmlMode: "foreign" };
        }
        let tag = `<${elem.name}`;
        const attribs = formatAttributes(elem.attribs, opts);
        if (attribs) {
            tag += ` ${attribs}`;
        }
        if (elem.children.length === 0 &&
            (opts.xmlMode
                ? // In XML mode or foreign mode, and user hasn't explicitly turned off self-closing tags
                    opts.selfClosingTags !== false
                : // User explicitly asked for self-closing tags, even in HTML mode
                    opts.selfClosingTags && singleTag.has(elem.name))) {
            if (!opts.xmlMode)
                tag += " ";
            tag += "/>";
        }
        else {
            tag += ">";
            if (elem.children.length > 0) {
                tag += render$1(elem.children, opts);
            }
            if (opts.xmlMode || !singleTag.has(elem.name)) {
                tag += `</${elem.name}>`;
            }
        }
        return tag;
    }
    function renderDirective(elem) {
        return `<${elem.data}>`;
    }
    function renderText(elem, opts) {
        var _a;
        let data = elem.data || "";
        // If entities weren't decoded, no need to encode them back
        if (((_a = opts.encodeEntities) !== null && _a !== void 0 ? _a : opts.decodeEntities) !== false &&
            !(!opts.xmlMode &&
                elem.parent &&
                unencodedElements.has(elem.parent.name))) {
            data =
                opts.xmlMode || opts.encodeEntities !== "utf8"
                    ? encodeXML(data)
                    : escapeText(data);
        }
        return data;
    }
    function renderCdata(elem) {
        return `<![CDATA[${elem.children[0].data}]]>`;
    }
    function renderComment(elem) {
        return `<!--${elem.data}-->`;
    }

    /**
     * @category Stringify
     * @deprecated Use the `dom-serializer` module directly.
     * @param node Node to get the outer HTML of.
     * @param options Options for serialization.
     * @returns `node`'s outer HTML.
     */
    function getOuterHTML(node, options) {
        return render$1(node, options);
    }
    /**
     * @category Stringify
     * @deprecated Use the `dom-serializer` module directly.
     * @param node Node to get the inner HTML of.
     * @param options Options for serialization.
     * @returns `node`'s inner HTML.
     */
    function getInnerHTML(node, options) {
        return hasChildren(node)
            ? node.children.map((node) => getOuterHTML(node, options)).join("")
            : "";
    }
    /**
     * Get a node's inner text. Same as `textContent`, but inserts newlines for `<br>` tags.
     *
     * @category Stringify
     * @deprecated Use `textContent` instead.
     * @param node Node to get the inner text of.
     * @returns `node`'s inner text.
     */
    function getText(node) {
        if (Array.isArray(node))
            return node.map(getText).join("");
        if (isTag(node))
            return node.name === "br" ? "\n" : getText(node.children);
        if (isCDATA(node))
            return getText(node.children);
        if (isText(node))
            return node.data;
        return "";
    }
    /**
     * Get a node's text content.
     *
     * @category Stringify
     * @param node Node to get the text content of.
     * @returns `node`'s text content.
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Node/textContent}
     */
    function textContent(node) {
        if (Array.isArray(node))
            return node.map(textContent).join("");
        if (hasChildren(node) && !isComment(node)) {
            return textContent(node.children);
        }
        if (isText(node))
            return node.data;
        return "";
    }
    /**
     * Get a node's inner text.
     *
     * @category Stringify
     * @param node Node to get the inner text of.
     * @returns `node`'s inner text.
     * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Node/innerText}
     */
    function innerText(node) {
        if (Array.isArray(node))
            return node.map(innerText).join("");
        if (hasChildren(node) && (node.type === ElementType.Tag || isCDATA(node))) {
            return innerText(node.children);
        }
        if (isText(node))
            return node.data;
        return "";
    }

    /**
     * Get a node's children.
     *
     * @category Traversal
     * @param elem Node to get the children of.
     * @returns `elem`'s children, or an empty array.
     */
    function getChildren(elem) {
        return hasChildren(elem) ? elem.children : [];
    }
    /**
     * Get a node's parent.
     *
     * @category Traversal
     * @param elem Node to get the parent of.
     * @returns `elem`'s parent node.
     */
    function getParent(elem) {
        return elem.parent || null;
    }
    /**
     * Gets an elements siblings, including the element itself.
     *
     * Attempts to get the children through the element's parent first. If we don't
     * have a parent (the element is a root node), we walk the element's `prev` &
     * `next` to get all remaining nodes.
     *
     * @category Traversal
     * @param elem Element to get the siblings of.
     * @returns `elem`'s siblings.
     */
    function getSiblings(elem) {
        const parent = getParent(elem);
        if (parent != null)
            return getChildren(parent);
        const siblings = [elem];
        let { prev, next } = elem;
        while (prev != null) {
            siblings.unshift(prev);
            ({ prev } = prev);
        }
        while (next != null) {
            siblings.push(next);
            ({ next } = next);
        }
        return siblings;
    }
    /**
     * Gets an attribute from an element.
     *
     * @category Traversal
     * @param elem Element to check.
     * @param name Attribute name to retrieve.
     * @returns The element's attribute value, or `undefined`.
     */
    function getAttributeValue(elem, name) {
        var _a;
        return (_a = elem.attribs) === null || _a === void 0 ? void 0 : _a[name];
    }
    /**
     * Checks whether an element has an attribute.
     *
     * @category Traversal
     * @param elem Element to check.
     * @param name Attribute name to look for.
     * @returns Returns whether `elem` has the attribute `name`.
     */
    function hasAttrib(elem, name) {
        return (elem.attribs != null &&
            Object.prototype.hasOwnProperty.call(elem.attribs, name) &&
            elem.attribs[name] != null);
    }
    /**
     * Get the tag name of an element.
     *
     * @category Traversal
     * @param elem The element to get the name for.
     * @returns The tag name of `elem`.
     */
    function getName(elem) {
        return elem.name;
    }
    /**
     * Returns the next element sibling of a node.
     *
     * @category Traversal
     * @param elem The element to get the next sibling of.
     * @returns `elem`'s next sibling that is a tag.
     */
    function nextElementSibling(elem) {
        let { next } = elem;
        while (next !== null && !isTag(next))
            ({ next } = next);
        return next;
    }
    /**
     * Returns the previous element sibling of a node.
     *
     * @category Traversal
     * @param elem The element to get the previous sibling of.
     * @returns `elem`'s previous sibling that is a tag.
     */
    function prevElementSibling(elem) {
        let { prev } = elem;
        while (prev !== null && !isTag(prev))
            ({ prev } = prev);
        return prev;
    }

    /**
     * Remove an element from the dom
     *
     * @category Manipulation
     * @param elem The element to be removed
     */
    function removeElement(elem) {
        if (elem.prev)
            elem.prev.next = elem.next;
        if (elem.next)
            elem.next.prev = elem.prev;
        if (elem.parent) {
            const childs = elem.parent.children;
            childs.splice(childs.lastIndexOf(elem), 1);
        }
    }
    /**
     * Replace an element in the dom
     *
     * @category Manipulation
     * @param elem The element to be replaced
     * @param replacement The element to be added
     */
    function replaceElement(elem, replacement) {
        const prev = (replacement.prev = elem.prev);
        if (prev) {
            prev.next = replacement;
        }
        const next = (replacement.next = elem.next);
        if (next) {
            next.prev = replacement;
        }
        const parent = (replacement.parent = elem.parent);
        if (parent) {
            const childs = parent.children;
            childs[childs.lastIndexOf(elem)] = replacement;
            elem.parent = null;
        }
    }
    /**
     * Append a child to an element.
     *
     * @category Manipulation
     * @param elem The element to append to.
     * @param child The element to be added as a child.
     */
    function appendChild(elem, child) {
        removeElement(child);
        child.next = null;
        child.parent = elem;
        if (elem.children.push(child) > 1) {
            const sibling = elem.children[elem.children.length - 2];
            sibling.next = child;
            child.prev = sibling;
        }
        else {
            child.prev = null;
        }
    }
    /**
     * Append an element after another.
     *
     * @category Manipulation
     * @param elem The element to append after.
     * @param next The element be added.
     */
    function append$1(elem, next) {
        removeElement(next);
        const { parent } = elem;
        const currNext = elem.next;
        next.next = currNext;
        next.prev = elem;
        elem.next = next;
        next.parent = parent;
        if (currNext) {
            currNext.prev = next;
            if (parent) {
                const childs = parent.children;
                childs.splice(childs.lastIndexOf(currNext), 0, next);
            }
        }
        else if (parent) {
            parent.children.push(next);
        }
    }
    /**
     * Prepend a child to an element.
     *
     * @category Manipulation
     * @param elem The element to prepend before.
     * @param child The element to be added as a child.
     */
    function prependChild(elem, child) {
        removeElement(child);
        child.parent = elem;
        child.prev = null;
        if (elem.children.unshift(child) !== 1) {
            const sibling = elem.children[1];
            sibling.prev = child;
            child.next = sibling;
        }
        else {
            child.next = null;
        }
    }
    /**
     * Prepend an element before another.
     *
     * @category Manipulation
     * @param elem The element to prepend before.
     * @param prev The element be added.
     */
    function prepend$1(elem, prev) {
        removeElement(prev);
        const { parent } = elem;
        if (parent) {
            const childs = parent.children;
            childs.splice(childs.indexOf(elem), 0, prev);
        }
        if (elem.prev) {
            elem.prev.next = prev;
        }
        prev.parent = parent;
        prev.prev = elem.prev;
        prev.next = elem;
        elem.prev = prev;
    }

    /**
     * Search a node and its children for nodes passing a test function.
     *
     * @category Querying
     * @param test Function to test nodes on.
     * @param node Node to search. Will be included in the result set if it matches.
     * @param recurse Also consider child nodes.
     * @param limit Maximum number of nodes to return.
     * @returns All nodes passing `test`.
     */
    function filter$2(test, node, recurse = true, limit = Infinity) {
        if (!Array.isArray(node))
            node = [node];
        return find$2(test, node, recurse, limit);
    }
    /**
     * Search an array of node and its children for nodes passing a test function.
     *
     * @category Querying
     * @param test Function to test nodes on.
     * @param nodes Array of nodes to search.
     * @param recurse Also consider child nodes.
     * @param limit Maximum number of nodes to return.
     * @returns All nodes passing `test`.
     */
    function find$2(test, nodes, recurse, limit) {
        const result = [];
        for (const elem of nodes) {
            if (test(elem)) {
                result.push(elem);
                if (--limit <= 0)
                    break;
            }
            if (recurse && hasChildren(elem) && elem.children.length > 0) {
                const children = find$2(test, elem.children, recurse, limit);
                result.push(...children);
                limit -= children.length;
                if (limit <= 0)
                    break;
            }
        }
        return result;
    }
    /**
     * Finds the first element inside of an array that matches a test function.
     *
     * @category Querying
     * @param test Function to test nodes on.
     * @param nodes Array of nodes to search.
     * @returns The first node in the array that passes `test`.
     * @deprecated Use `Array.prototype.find` directly.
     */
    function findOneChild(test, nodes) {
        return nodes.find(test);
    }
    /**
     * Finds one element in a tree that passes a test.
     *
     * @category Querying
     * @param test Function to test nodes on.
     * @param nodes Array of nodes to search.
     * @param recurse Also consider child nodes.
     * @returns The first child node that passes `test`.
     */
    function findOne(test, nodes, recurse = true) {
        let elem = null;
        for (let i = 0; i < nodes.length && !elem; i++) {
            const checked = nodes[i];
            if (!isTag(checked)) {
                continue;
            }
            else if (test(checked)) {
                elem = checked;
            }
            else if (recurse && checked.children.length > 0) {
                elem = findOne(test, checked.children, true);
            }
        }
        return elem;
    }
    /**
     * @category Querying
     * @param test Function to test nodes on.
     * @param nodes Array of nodes to search.
     * @returns Whether a tree of nodes contains at least one node passing the test.
     */
    function existsOne(test, nodes) {
        return nodes.some((checked) => isTag(checked) &&
            (test(checked) ||
                (checked.children.length > 0 &&
                    existsOne(test, checked.children))));
    }
    /**
     * Search and array of nodes and its children for elements passing a test function.
     *
     * Same as `find`, but limited to elements and with less options, leading to reduced complexity.
     *
     * @category Querying
     * @param test Function to test nodes on.
     * @param nodes Array of nodes to search.
     * @returns All nodes passing `test`.
     */
    function findAll(test, nodes) {
        var _a;
        const result = [];
        const stack = nodes.filter(isTag);
        let elem;
        while ((elem = stack.shift())) {
            const children = (_a = elem.children) === null || _a === void 0 ? void 0 : _a.filter(isTag);
            if (children && children.length > 0) {
                stack.unshift(...children);
            }
            if (test(elem))
                result.push(elem);
        }
        return result;
    }

    const Checks = {
        tag_name(name) {
            if (typeof name === "function") {
                return (elem) => isTag(elem) && name(elem.name);
            }
            else if (name === "*") {
                return isTag;
            }
            return (elem) => isTag(elem) && elem.name === name;
        },
        tag_type(type) {
            if (typeof type === "function") {
                return (elem) => type(elem.type);
            }
            return (elem) => elem.type === type;
        },
        tag_contains(data) {
            if (typeof data === "function") {
                return (elem) => isText(elem) && data(elem.data);
            }
            return (elem) => isText(elem) && elem.data === data;
        },
    };
    /**
     * @param attrib Attribute to check.
     * @param value Attribute value to look for.
     * @returns A function to check whether the a node has an attribute with a
     *   particular value.
     */
    function getAttribCheck(attrib, value) {
        if (typeof value === "function") {
            return (elem) => isTag(elem) && value(elem.attribs[attrib]);
        }
        return (elem) => isTag(elem) && elem.attribs[attrib] === value;
    }
    /**
     * @param a First function to combine.
     * @param b Second function to combine.
     * @returns A function taking a node and returning `true` if either of the input
     *   functions returns `true` for the node.
     */
    function combineFuncs(a, b) {
        return (elem) => a(elem) || b(elem);
    }
    /**
     * @param options An object describing nodes to look for.
     * @returns A function executing all checks in `options` and returning `true` if
     *   any of them match a node.
     */
    function compileTest(options) {
        const funcs = Object.keys(options).map((key) => {
            const value = options[key];
            return Object.prototype.hasOwnProperty.call(Checks, key)
                ? Checks[key](value)
                : getAttribCheck(key, value);
        });
        return funcs.length === 0 ? null : funcs.reduce(combineFuncs);
    }
    /**
     * @category Legacy Query Functions
     * @param options An object describing nodes to look for.
     * @param node The element to test.
     * @returns Whether the element matches the description in `options`.
     */
    function testElement(options, node) {
        const test = compileTest(options);
        return test ? test(node) : true;
    }
    /**
     * @category Legacy Query Functions
     * @param options An object describing nodes to look for.
     * @param nodes Nodes to search through.
     * @param recurse Also consider child nodes.
     * @param limit Maximum number of nodes to return.
     * @returns All nodes that match `options`.
     */
    function getElements(options, nodes, recurse, limit = Infinity) {
        const test = compileTest(options);
        return test ? filter$2(test, nodes, recurse, limit) : [];
    }
    /**
     * @category Legacy Query Functions
     * @param id The unique ID attribute value to look for.
     * @param nodes Nodes to search through.
     * @param recurse Also consider child nodes.
     * @returns The node with the supplied ID.
     */
    function getElementById(id, nodes, recurse = true) {
        if (!Array.isArray(nodes))
            nodes = [nodes];
        return findOne(getAttribCheck("id", id), nodes, recurse);
    }
    /**
     * @category Legacy Query Functions
     * @param tagName Tag name to search for.
     * @param nodes Nodes to search through.
     * @param recurse Also consider child nodes.
     * @param limit Maximum number of nodes to return.
     * @returns All nodes with the supplied `tagName`.
     */
    function getElementsByTagName(tagName, nodes, recurse = true, limit = Infinity) {
        return filter$2(Checks["tag_name"](tagName), nodes, recurse, limit);
    }
    /**
     * @category Legacy Query Functions
     * @param type Element type to look for.
     * @param nodes Nodes to search through.
     * @param recurse Also consider child nodes.
     * @param limit Maximum number of nodes to return.
     * @returns All nodes with the supplied `type`.
     */
    function getElementsByTagType(type, nodes, recurse = true, limit = Infinity) {
        return filter$2(Checks["tag_type"](type), nodes, recurse, limit);
    }

    /**
     * Given an array of nodes, remove any member that is contained by another.
     *
     * @category Helpers
     * @param nodes Nodes to filter.
     * @returns Remaining nodes that aren't subtrees of each other.
     */
    function removeSubsets(nodes) {
        let idx = nodes.length;
        /*
         * Check if each node (or one of its ancestors) is already contained in the
         * array.
         */
        while (--idx >= 0) {
            const node = nodes[idx];
            /*
             * Remove the node if it is not unique.
             * We are going through the array from the end, so we only
             * have to check nodes that preceed the node under consideration in the array.
             */
            if (idx > 0 && nodes.lastIndexOf(node, idx - 1) >= 0) {
                nodes.splice(idx, 1);
                continue;
            }
            for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
                if (nodes.includes(ancestor)) {
                    nodes.splice(idx, 1);
                    break;
                }
            }
        }
        return nodes;
    }
    /**
     * @category Helpers
     * @see {@link http://dom.spec.whatwg.org/#dom-node-comparedocumentposition}
     */
    var DocumentPosition;
    (function (DocumentPosition) {
        DocumentPosition[DocumentPosition["DISCONNECTED"] = 1] = "DISCONNECTED";
        DocumentPosition[DocumentPosition["PRECEDING"] = 2] = "PRECEDING";
        DocumentPosition[DocumentPosition["FOLLOWING"] = 4] = "FOLLOWING";
        DocumentPosition[DocumentPosition["CONTAINS"] = 8] = "CONTAINS";
        DocumentPosition[DocumentPosition["CONTAINED_BY"] = 16] = "CONTAINED_BY";
    })(DocumentPosition || (DocumentPosition = {}));
    /**
     * Compare the position of one node against another node in any other document.
     * The return value is a bitmask with the values from {@link DocumentPosition}.
     *
     * Document order:
     * > There is an ordering, document order, defined on all the nodes in the
     * > document corresponding to the order in which the first character of the
     * > XML representation of each node occurs in the XML representation of the
     * > document after expansion of general entities. Thus, the document element
     * > node will be the first node. Element nodes occur before their children.
     * > Thus, document order orders element nodes in order of the occurrence of
     * > their start-tag in the XML (after expansion of entities). The attribute
     * > nodes of an element occur after the element and before its children. The
     * > relative order of attribute nodes is implementation-dependent.
     *
     * Source:
     * http://www.w3.org/TR/DOM-Level-3-Core/glossary.html#dt-document-order
     *
     * @category Helpers
     * @param nodeA The first node to use in the comparison
     * @param nodeB The second node to use in the comparison
     * @returns A bitmask describing the input nodes' relative position.
     *
     * See http://dom.spec.whatwg.org/#dom-node-comparedocumentposition for
     * a description of these values.
     */
    function compareDocumentPosition(nodeA, nodeB) {
        const aParents = [];
        const bParents = [];
        if (nodeA === nodeB) {
            return 0;
        }
        let current = hasChildren(nodeA) ? nodeA : nodeA.parent;
        while (current) {
            aParents.unshift(current);
            current = current.parent;
        }
        current = hasChildren(nodeB) ? nodeB : nodeB.parent;
        while (current) {
            bParents.unshift(current);
            current = current.parent;
        }
        const maxIdx = Math.min(aParents.length, bParents.length);
        let idx = 0;
        while (idx < maxIdx && aParents[idx] === bParents[idx]) {
            idx++;
        }
        if (idx === 0) {
            return DocumentPosition.DISCONNECTED;
        }
        const sharedParent = aParents[idx - 1];
        const siblings = sharedParent.children;
        const aSibling = aParents[idx];
        const bSibling = bParents[idx];
        if (siblings.indexOf(aSibling) > siblings.indexOf(bSibling)) {
            if (sharedParent === nodeB) {
                return DocumentPosition.FOLLOWING | DocumentPosition.CONTAINED_BY;
            }
            return DocumentPosition.FOLLOWING;
        }
        if (sharedParent === nodeA) {
            return DocumentPosition.PRECEDING | DocumentPosition.CONTAINS;
        }
        return DocumentPosition.PRECEDING;
    }
    /**
     * Sort an array of nodes based on their relative position in the document and
     * remove any duplicate nodes. If the array contains nodes that do not belong to
     * the same document, sort order is unspecified.
     *
     * @category Helpers
     * @param nodes Array of DOM nodes.
     * @returns Collection of unique nodes, sorted in document order.
     */
    function uniqueSort(nodes) {
        nodes = nodes.filter((node, i, arr) => !arr.includes(node, i + 1));
        nodes.sort((a, b) => {
            const relative = compareDocumentPosition(a, b);
            if (relative & DocumentPosition.PRECEDING) {
                return -1;
            }
            else if (relative & DocumentPosition.FOLLOWING) {
                return 1;
            }
            return 0;
        });
        return nodes;
    }

    /**
     * Get the feed object from the root of a DOM tree.
     *
     * @category Feeds
     * @param doc - The DOM to to extract the feed from.
     * @returns The feed.
     */
    function getFeed(doc) {
        const feedRoot = getOneElement(isValidFeed, doc);
        return !feedRoot
            ? null
            : feedRoot.name === "feed"
                ? getAtomFeed(feedRoot)
                : getRssFeed(feedRoot);
    }
    /**
     * Parse an Atom feed.
     *
     * @param feedRoot The root of the feed.
     * @returns The parsed feed.
     */
    function getAtomFeed(feedRoot) {
        var _a;
        const childs = feedRoot.children;
        const feed = {
            type: "atom",
            items: getElementsByTagName("entry", childs).map((item) => {
                var _a;
                const { children } = item;
                const entry = { media: getMediaElements(children) };
                addConditionally(entry, "id", "id", children);
                addConditionally(entry, "title", "title", children);
                const href = (_a = getOneElement("link", children)) === null || _a === void 0 ? void 0 : _a.attribs["href"];
                if (href) {
                    entry.link = href;
                }
                const description = fetch("summary", children) || fetch("content", children);
                if (description) {
                    entry.description = description;
                }
                const pubDate = fetch("updated", children);
                if (pubDate) {
                    entry.pubDate = new Date(pubDate);
                }
                return entry;
            }),
        };
        addConditionally(feed, "id", "id", childs);
        addConditionally(feed, "title", "title", childs);
        const href = (_a = getOneElement("link", childs)) === null || _a === void 0 ? void 0 : _a.attribs["href"];
        if (href) {
            feed.link = href;
        }
        addConditionally(feed, "description", "subtitle", childs);
        const updated = fetch("updated", childs);
        if (updated) {
            feed.updated = new Date(updated);
        }
        addConditionally(feed, "author", "email", childs, true);
        return feed;
    }
    /**
     * Parse a RSS feed.
     *
     * @param feedRoot The root of the feed.
     * @returns The parsed feed.
     */
    function getRssFeed(feedRoot) {
        var _a, _b;
        const childs = (_b = (_a = getOneElement("channel", feedRoot.children)) === null || _a === void 0 ? void 0 : _a.children) !== null && _b !== void 0 ? _b : [];
        const feed = {
            type: feedRoot.name.substr(0, 3),
            id: "",
            items: getElementsByTagName("item", feedRoot.children).map((item) => {
                const { children } = item;
                const entry = { media: getMediaElements(children) };
                addConditionally(entry, "id", "guid", children);
                addConditionally(entry, "title", "title", children);
                addConditionally(entry, "link", "link", children);
                addConditionally(entry, "description", "description", children);
                const pubDate = fetch("pubDate", children);
                if (pubDate)
                    entry.pubDate = new Date(pubDate);
                return entry;
            }),
        };
        addConditionally(feed, "title", "title", childs);
        addConditionally(feed, "link", "link", childs);
        addConditionally(feed, "description", "description", childs);
        const updated = fetch("lastBuildDate", childs);
        if (updated) {
            feed.updated = new Date(updated);
        }
        addConditionally(feed, "author", "managingEditor", childs, true);
        return feed;
    }
    const MEDIA_KEYS_STRING = ["url", "type", "lang"];
    const MEDIA_KEYS_INT = [
        "fileSize",
        "bitrate",
        "framerate",
        "samplingrate",
        "channels",
        "duration",
        "height",
        "width",
    ];
    /**
     * Get all media elements of a feed item.
     *
     * @param where Nodes to search in.
     * @returns Media elements.
     */
    function getMediaElements(where) {
        return getElementsByTagName("media:content", where).map((elem) => {
            const { attribs } = elem;
            const media = {
                medium: attribs["medium"],
                isDefault: !!attribs["isDefault"],
            };
            for (const attrib of MEDIA_KEYS_STRING) {
                if (attribs[attrib]) {
                    media[attrib] = attribs[attrib];
                }
            }
            for (const attrib of MEDIA_KEYS_INT) {
                if (attribs[attrib]) {
                    media[attrib] = parseInt(attribs[attrib], 10);
                }
            }
            if (attribs["expression"]) {
                media.expression = attribs["expression"];
            }
            return media;
        });
    }
    /**
     * Get one element by tag name.
     *
     * @param tagName Tag name to look for
     * @param node Node to search in
     * @returns The element or null
     */
    function getOneElement(tagName, node) {
        return getElementsByTagName(tagName, node, true, 1)[0];
    }
    /**
     * Get the text content of an element with a certain tag name.
     *
     * @param tagName Tag name to look for.
     * @param where Node to search in.
     * @param recurse Whether to recurse into child nodes.
     * @returns The text content of the element.
     */
    function fetch(tagName, where, recurse = false) {
        return textContent(getElementsByTagName(tagName, where, recurse, 1)).trim();
    }
    /**
     * Adds a property to an object if it has a value.
     *
     * @param obj Object to be extended
     * @param prop Property name
     * @param tagName Tag name that contains the conditionally added property
     * @param where Element to search for the property
     * @param recurse Whether to recurse into child nodes.
     */
    function addConditionally(obj, prop, tagName, where, recurse = false) {
        const val = fetch(tagName, where, recurse);
        if (val)
            obj[prop] = val;
    }
    /**
     * Checks if an element is a feed root node.
     *
     * @param value The name of the element to check.
     * @returns Whether an element is a feed root node.
     */
    function isValidFeed(value) {
        return value === "rss" || value === "feed" || value === "rdf:RDF";
    }

    var DomUtils = /*#__PURE__*/Object.freeze({
        __proto__: null,
        isTag: isTag,
        isCDATA: isCDATA,
        isText: isText,
        isComment: isComment,
        isDocument: isDocument,
        hasChildren: hasChildren,
        getOuterHTML: getOuterHTML,
        getInnerHTML: getInnerHTML,
        getText: getText,
        textContent: textContent,
        innerText: innerText,
        getChildren: getChildren,
        getParent: getParent,
        getSiblings: getSiblings,
        getAttributeValue: getAttributeValue,
        hasAttrib: hasAttrib,
        getName: getName,
        nextElementSibling: nextElementSibling,
        prevElementSibling: prevElementSibling,
        removeElement: removeElement,
        replaceElement: replaceElement,
        appendChild: appendChild,
        append: append$1,
        prependChild: prependChild,
        prepend: prepend$1,
        filter: filter$2,
        find: find$2,
        findOneChild: findOneChild,
        findOne: findOne,
        existsOne: existsOne,
        findAll: findAll,
        testElement: testElement,
        getElements: getElements,
        getElementById: getElementById,
        getElementsByTagName: getElementsByTagName,
        getElementsByTagType: getElementsByTagType,
        removeSubsets: removeSubsets,
        get DocumentPosition () { return DocumentPosition; },
        compareDocumentPosition: compareDocumentPosition,
        uniqueSort: uniqueSort,
        getFeed: getFeed
    });

    /**
     * Helper function to render a DOM.
     *
     * @param that - Cheerio instance to render.
     * @param dom - The DOM to render. Defaults to `that`'s root.
     * @param options - Options for rendering.
     * @returns The rendered document.
     */
    function render(that, dom, options) {
        if (!that)
            return '';
        return that(dom !== null && dom !== void 0 ? dom : that._root.children, null, undefined, options).toString();
    }
    /**
     * Checks if a passed object is an options object.
     *
     * @param dom - Object to check if it is an options object.
     * @returns Whether the object is an options object.
     */
    function isOptions(dom, options) {
        return (!options &&
            typeof dom === 'object' &&
            dom != null &&
            !('length' in dom) &&
            !('type' in dom));
    }
    function html$1(dom, options) {
        /*
         * Be flexible about parameters, sometimes we call html(),
         * with options as only parameter
         * check dom argument for dom element specific properties
         * assume there is no 'length' or 'type' properties in the options object
         */
        const toRender = isOptions(dom) ? ((options = dom), undefined) : dom;
        /*
         * Sometimes `$.html()` is used without preloading html,
         * so fallback non-existing options to the default ones.
         */
        const opts = {
            ...defaultOpts$2,
            ...this === null || this === void 0 ? void 0 : this._options,
            ...flatten(options !== null && options !== void 0 ? options : {}),
        };
        return render(this, toRender, opts);
    }
    /**
     * Render the document as XML.
     *
     * @param dom - Element to render.
     * @returns THe rendered document.
     */
    function xml(dom) {
        const options = { ...this._options, xmlMode: true };
        return render(this, dom, options);
    }
    /**
     * Render the document as text.
     *
     * This returns the `textContent` of the passed elements. The result will
     * include the contents of `script` and `stype` elements. To avoid this, use
     * `.prop('innerText')` instead.
     *
     * @param elements - Elements to render.
     * @returns The rendered document.
     */
    function text$1(elements) {
        const elems = elements ? elements : this ? this.root() : [];
        let ret = '';
        for (let i = 0; i < elems.length; i++) {
            ret += textContent(elems[i]);
        }
        return ret;
    }
    function parseHTML(data, context, keepScripts = typeof context === 'boolean' ? context : false) {
        if (!data || typeof data !== 'string') {
            return null;
        }
        if (typeof context === 'boolean') {
            keepScripts = context;
        }
        const parsed = this.load(data, defaultOpts$2, false);
        if (!keepScripts) {
            parsed('script').remove();
        }
        /*
         * The `children` array is used by Cheerio internally to group elements that
         * share the same parents. When nodes created through `parseHTML` are
         * inserted into previously-existing DOM structures, they will be removed
         * from the `children` array. The results of `parseHTML` should remain
         * constant across these operations, so a shallow copy should be returned.
         */
        return parsed.root()[0].children.slice();
    }
    /**
     * Sometimes you need to work with the top-level root element. To query it, you
     * can use `$.root()`.
     *
     * @example
     *
     * ```js
     * $.root().append('<ul id="vegetables"></ul>').html();
     * //=> <ul id="fruits">...</ul><ul id="vegetables"></ul>
     * ```
     *
     * @returns Cheerio instance wrapping the root node.
     * @alias Cheerio.root
     */
    function root() {
        return this(this._root);
    }
    /**
     * Checks to see if the `contained` DOM element is a descendant of the
     * `container` DOM element.
     *
     * @param container - Potential parent node.
     * @param contained - Potential child node.
     * @returns Indicates if the nodes contain one another.
     * @alias Cheerio.contains
     * @see {@link https://api.jquery.com/jQuery.contains/}
     */
    function contains(container, contained) {
        // According to the jQuery API, an element does not "contain" itself
        if (contained === container) {
            return false;
        }
        /*
         * Step up the descendants, stopping when the root element is reached
         * (signaled by `.parent` returning a reference to the same object)
         */
        let next = contained;
        while (next && next !== next.parent) {
            next = next.parent;
            if (next === container) {
                return true;
            }
        }
        return false;
    }
    /**
     * $.merge().
     *
     * @param arr1 - First array.
     * @param arr2 - Second array.
     * @returns `arr1`, with elements of `arr2` inserted.
     * @alias Cheerio.merge
     * @see {@link https://api.jquery.com/jQuery.merge/}
     */
    function merge(arr1, arr2) {
        if (!isArrayLike(arr1) || !isArrayLike(arr2)) {
            return;
        }
        let newLength = arr1.length;
        const len = +arr2.length;
        for (let i = 0; i < len; i++) {
            arr1[newLength++] = arr2[i];
        }
        arr1.length = newLength;
        return arr1;
    }
    /**
     * Checks if an object is array-like.
     *
     * @param item - Item to check.
     * @returns Indicates if the item is array-like.
     */
    function isArrayLike(item) {
        if (Array.isArray(item)) {
            return true;
        }
        if (typeof item !== 'object' ||
            !Object.prototype.hasOwnProperty.call(item, 'length') ||
            typeof item.length !== 'number' ||
            item.length < 0) {
            return false;
        }
        for (let i = 0; i < item.length; i++) {
            if (!(i in item)) {
                return false;
            }
        }
        return true;
    }

    var staticMethods = /*#__PURE__*/Object.freeze({
        __proto__: null,
        html: html$1,
        xml: xml,
        text: text$1,
        parseHTML: parseHTML,
        root: root,
        contains: contains,
        merge: merge
    });

    /**
     * Checks if an object is a Cheerio instance.
     *
     * @category Utils
     * @param maybeCheerio - The object to check.
     * @returns Whether the object is a Cheerio instance.
     */
    function isCheerio(maybeCheerio) {
        return maybeCheerio.cheerio != null;
    }
    /**
     * Convert a string to camel case notation.
     *
     * @private
     * @category Utils
     * @param str - The string to be converted.
     * @returns String in camel case notation.
     */
    function camelCase(str) {
        return str.replace(/[_.-](\w|$)/g, (_, x) => x.toUpperCase());
    }
    /**
     * Convert a string from camel case to "CSS case", where word boundaries are
     * described by hyphens ("-") and all characters are lower-case.
     *
     * @private
     * @category Utils
     * @param str - The string to be converted.
     * @returns String in "CSS case".
     */
    function cssCase(str) {
        return str.replace(/[A-Z]/g, '-$&').toLowerCase();
    }
    /**
     * Iterate over each DOM element without creating intermediary Cheerio instances.
     *
     * This is indented for use internally to avoid otherwise unnecessary memory
     * pressure introduced by _make.
     *
     * @category Utils
     * @param array - The array to iterate over.
     * @param fn - Function to call.
     * @returns The original instance.
     */
    function domEach(array, fn) {
        const len = array.length;
        for (let i = 0; i < len; i++)
            fn(array[i], i);
        return array;
    }
    /**
     * Create a deep copy of the given DOM structure. Sets the parents of the copies
     * of the passed nodes to `null`.
     *
     * @private
     * @category Utils
     * @param dom - The domhandler-compliant DOM structure.
     * @returns - The cloned DOM.
     */
    function cloneDom(dom) {
        const clone = 'length' in dom
            ? Array.prototype.map.call(dom, (el) => cloneNode(el, true))
            : [cloneNode(dom, true)];
        // Add a root node around the cloned nodes
        const root = new Document(clone);
        clone.forEach((node) => {
            node.parent = root;
        });
        return clone;
    }
    var CharacterCodes;
    (function (CharacterCodes) {
        CharacterCodes[CharacterCodes["LowerA"] = 97] = "LowerA";
        CharacterCodes[CharacterCodes["LowerZ"] = 122] = "LowerZ";
        CharacterCodes[CharacterCodes["UpperA"] = 65] = "UpperA";
        CharacterCodes[CharacterCodes["UpperZ"] = 90] = "UpperZ";
        CharacterCodes[CharacterCodes["Exclamation"] = 33] = "Exclamation";
    })(CharacterCodes || (CharacterCodes = {}));
    /**
     * Check if string is HTML.
     *
     * Tests for a `<` within a string, immediate followed by a letter and
     * eventually followed by a `>`.
     *
     * @private
     * @category Utils
     * @param str - The string to check.
     * @returns Indicates if `str` is HTML.
     */
    function isHtml(str) {
        const tagStart = str.indexOf('<');
        if (tagStart < 0 || tagStart > str.length - 3)
            return false;
        const tagChar = str.charCodeAt(tagStart + 1);
        return (((tagChar >= CharacterCodes.LowerA && tagChar <= CharacterCodes.LowerZ) ||
            (tagChar >= CharacterCodes.UpperA && tagChar <= CharacterCodes.UpperZ) ||
            tagChar === CharacterCodes.Exclamation) &&
            str.includes('>', tagStart + 2));
    }

    /**
     * Methods for getting and modifying attributes.
     *
     * @module cheerio/attributes
     */
    const hasOwn = Object.prototype.hasOwnProperty;
    const rspace = /\s+/;
    const dataAttrPrefix = 'data-';
    /*
     * Lookup table for coercing string data-* attributes to their corresponding
     * JavaScript primitives
     */
    const primitives = {
        null: null,
        true: true,
        false: false,
    };
    // Attributes that are booleans
    const rboolean = /^(?:autofocus|autoplay|async|checked|controls|defer|disabled|hidden|loop|multiple|open|readonly|required|scoped|selected)$/i;
    // Matches strings that look like JSON objects or arrays
    const rbrace = /^{[^]*}$|^\[[^]*]$/;
    function getAttr(elem, name, xmlMode) {
        var _a;
        if (!elem || !isTag(elem))
            return undefined;
        (_a = elem.attribs) !== null && _a !== void 0 ? _a : (elem.attribs = {});
        // Return the entire attribs object if no attribute specified
        if (!name) {
            return elem.attribs;
        }
        if (hasOwn.call(elem.attribs, name)) {
            // Get the (decoded) attribute
            return !xmlMode && rboolean.test(name) ? name : elem.attribs[name];
        }
        // Mimic the DOM and return text content as value for `option's`
        if (elem.name === 'option' && name === 'value') {
            return text$1(elem.children);
        }
        // Mimic DOM with default value for radios/checkboxes
        if (elem.name === 'input' &&
            (elem.attribs['type'] === 'radio' || elem.attribs['type'] === 'checkbox') &&
            name === 'value') {
            return 'on';
        }
        return undefined;
    }
    /**
     * Sets the value of an attribute. The attribute will be deleted if the value is `null`.
     *
     * @private
     * @param el - The element to set the attribute on.
     * @param name - The attribute's name.
     * @param value - The attribute's value.
     */
    function setAttr(el, name, value) {
        if (value === null) {
            removeAttribute(el, name);
        }
        else {
            el.attribs[name] = `${value}`;
        }
    }
    function attr(name, value) {
        // Set the value (with attr map support)
        if (typeof name === 'object' || value !== undefined) {
            if (typeof value === 'function') {
                if (typeof name !== 'string') {
                    {
                        throw new Error('Bad combination of arguments.');
                    }
                }
                return domEach(this, (el, i) => {
                    if (isTag(el))
                        setAttr(el, name, value.call(el, i, el.attribs[name]));
                });
            }
            return domEach(this, (el) => {
                if (!isTag(el))
                    return;
                if (typeof name === 'object') {
                    Object.keys(name).forEach((objName) => {
                        const objValue = name[objName];
                        setAttr(el, objName, objValue);
                    });
                }
                else {
                    setAttr(el, name, value);
                }
            });
        }
        return arguments.length > 1
            ? this
            : getAttr(this[0], name, this.options.xmlMode);
    }
    /**
     * Gets a node's prop.
     *
     * @private
     * @category Attributes
     * @param el - Element to get the prop of.
     * @param name - Name of the prop.
     * @returns The prop's value.
     */
    function getProp(el, name, xmlMode) {
        return name in el
            ? // @ts-expect-error TS doesn't like us accessing the value directly here.
                el[name]
            : !xmlMode && rboolean.test(name)
                ? getAttr(el, name, false) !== undefined
                : getAttr(el, name, xmlMode);
    }
    /**
     * Sets the value of a prop.
     *
     * @private
     * @param el - The element to set the prop on.
     * @param name - The prop's name.
     * @param value - The prop's value.
     */
    function setProp(el, name, value, xmlMode) {
        if (name in el) {
            // @ts-expect-error Overriding value
            el[name] = value;
        }
        else {
            setAttr(el, name, !xmlMode && rboolean.test(name) ? (value ? '' : null) : `${value}`);
        }
    }
    function prop(name, value) {
        var _a;
        if (typeof name === 'string' && value === undefined) {
            const el = this[0];
            if (!el || !isTag(el))
                return undefined;
            switch (name) {
                case 'style': {
                    const property = this.css();
                    const keys = Object.keys(property);
                    keys.forEach((p, i) => {
                        property[i] = p;
                    });
                    property.length = keys.length;
                    return property;
                }
                case 'tagName':
                case 'nodeName': {
                    return el.name.toUpperCase();
                }
                case 'href':
                case 'src': {
                    const prop = (_a = el.attribs) === null || _a === void 0 ? void 0 : _a[name];
                    /* eslint-disable node/no-unsupported-features/node-builtins */
                    if (typeof URL !== 'undefined' &&
                        ((name === 'href' && (el.tagName === 'a' || el.name === 'link')) ||
                            (name === 'src' &&
                                (el.tagName === 'img' ||
                                    el.tagName === 'iframe' ||
                                    el.tagName === 'audio' ||
                                    el.tagName === 'video' ||
                                    el.tagName === 'source'))) &&
                        prop !== undefined &&
                        this.options.baseURI) {
                        return new URL(prop, this.options.baseURI).href;
                    }
                    /* eslint-enable node/no-unsupported-features/node-builtins */
                    return prop;
                }
                case 'innerText': {
                    return innerText(el);
                }
                case 'textContent': {
                    return textContent(el);
                }
                case 'outerHTML':
                    return this.clone().wrap('<container />').parent().html();
                case 'innerHTML':
                    return this.html();
                default:
                    return getProp(el, name, this.options.xmlMode);
            }
        }
        if (typeof name === 'object' || value !== undefined) {
            if (typeof value === 'function') {
                if (typeof name === 'object') {
                    throw new Error('Bad combination of arguments.');
                }
                return domEach(this, (el, i) => {
                    if (isTag(el)) {
                        setProp(el, name, value.call(el, i, getProp(el, name, this.options.xmlMode)), this.options.xmlMode);
                    }
                });
            }
            return domEach(this, (el) => {
                if (!isTag(el))
                    return;
                if (typeof name === 'object') {
                    Object.keys(name).forEach((key) => {
                        const val = name[key];
                        setProp(el, key, val, this.options.xmlMode);
                    });
                }
                else {
                    setProp(el, name, value, this.options.xmlMode);
                }
            });
        }
        return undefined;
    }
    /**
     * Sets the value of a data attribute.
     *
     * @private
     * @param el - The element to set the data attribute on.
     * @param name - The data attribute's name.
     * @param value - The data attribute's value.
     */
    function setData(el, name, value) {
        var _a;
        const elem = el;
        (_a = elem.data) !== null && _a !== void 0 ? _a : (elem.data = {});
        if (typeof name === 'object')
            Object.assign(elem.data, name);
        else if (typeof name === 'string' && value !== undefined) {
            elem.data[name] = value;
        }
    }
    /**
     * Read the specified attribute from the equivalent HTML5 `data-*` attribute,
     * and (if present) cache the value in the node's internal data store. If no
     * attribute name is specified, read _all_ HTML5 `data-*` attributes in this manner.
     *
     * @private
     * @category Attributes
     * @param el - Element to get the data attribute of.
     * @param name - Name of the data attribute.
     * @returns The data attribute's value, or a map with all of the data attributes.
     */
    function readData(el, name) {
        let domNames;
        let jsNames;
        let value;
        if (name == null) {
            domNames = Object.keys(el.attribs).filter((attrName) => attrName.startsWith(dataAttrPrefix));
            jsNames = domNames.map((domName) => camelCase(domName.slice(dataAttrPrefix.length)));
        }
        else {
            domNames = [dataAttrPrefix + cssCase(name)];
            jsNames = [name];
        }
        for (let idx = 0; idx < domNames.length; ++idx) {
            const domName = domNames[idx];
            const jsName = jsNames[idx];
            if (hasOwn.call(el.attribs, domName) &&
                !hasOwn.call(el.data, jsName)) {
                value = el.attribs[domName];
                if (hasOwn.call(primitives, value)) {
                    value = primitives[value];
                }
                else if (value === String(Number(value))) {
                    value = Number(value);
                }
                else if (rbrace.test(value)) {
                    try {
                        value = JSON.parse(value);
                    }
                    catch (e) {
                        /* Ignore */
                    }
                }
                el.data[jsName] = value;
            }
        }
        return name == null ? el.data : value;
    }
    function data(name, value) {
        var _a;
        const elem = this[0];
        if (!elem || !isTag(elem))
            return;
        const dataEl = elem;
        (_a = dataEl.data) !== null && _a !== void 0 ? _a : (dataEl.data = {});
        // Return the entire data object if no data specified
        if (!name) {
            return readData(dataEl);
        }
        // Set the value (with attr map support)
        if (typeof name === 'object' || value !== undefined) {
            domEach(this, (el) => {
                if (isTag(el)) {
                    if (typeof name === 'object')
                        setData(el, name);
                    else
                        setData(el, name, value);
                }
            });
            return this;
        }
        if (hasOwn.call(dataEl.data, name)) {
            return dataEl.data[name];
        }
        return readData(dataEl, name);
    }
    function val(value) {
        const querying = arguments.length === 0;
        const element = this[0];
        if (!element || !isTag(element))
            return querying ? undefined : this;
        switch (element.name) {
            case 'textarea':
                return this.text(value);
            case 'select': {
                const option = this.find('option:selected');
                if (!querying) {
                    if (this.attr('multiple') == null && typeof value === 'object') {
                        return this;
                    }
                    this.find('option').removeAttr('selected');
                    const values = typeof value !== 'object' ? [value] : value;
                    for (let i = 0; i < values.length; i++) {
                        this.find(`option[value="${values[i]}"]`).attr('selected', '');
                    }
                    return this;
                }
                return this.attr('multiple')
                    ? option.toArray().map((el) => text$1(el.children))
                    : option.attr('value');
            }
            case 'input':
            case 'option':
                return querying
                    ? this.attr('value')
                    : this.attr('value', value);
        }
        return undefined;
    }
    /**
     * Remove an attribute.
     *
     * @private
     * @param elem - Node to remove attribute from.
     * @param name - Name of the attribute to remove.
     */
    function removeAttribute(elem, name) {
        if (!elem.attribs || !hasOwn.call(elem.attribs, name))
            return;
        delete elem.attribs[name];
    }
    /**
     * Splits a space-separated list of names to individual names.
     *
     * @category Attributes
     * @param names - Names to split.
     * @returns - Split names.
     */
    function splitNames(names) {
        return names ? names.trim().split(rspace) : [];
    }
    /**
     * Method for removing attributes by `name`.
     *
     * @category Attributes
     * @example
     *
     * ```js
     * $('.pear').removeAttr('class').html();
     * //=> <li>Pear</li>
     *
     * $('.apple').attr('id', 'favorite');
     * $('.apple').removeAttr('id class').html();
     * //=> <li>Apple</li>
     * ```
     *
     * @param name - Name of the attribute.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/removeAttr/}
     */
    function removeAttr(name) {
        const attrNames = splitNames(name);
        for (let i = 0; i < attrNames.length; i++) {
            domEach(this, (elem) => {
                if (isTag(elem))
                    removeAttribute(elem, attrNames[i]);
            });
        }
        return this;
    }
    /**
     * Check to see if _any_ of the matched elements have the given `className`.
     *
     * @category Attributes
     * @example
     *
     * ```js
     * $('.pear').hasClass('pear');
     * //=> true
     *
     * $('apple').hasClass('fruit');
     * //=> false
     *
     * $('li').hasClass('pear');
     * //=> true
     * ```
     *
     * @param className - Name of the class.
     * @returns Indicates if an element has the given `className`.
     * @see {@link https://api.jquery.com/hasClass/}
     */
    function hasClass(className) {
        return this.toArray().some((elem) => {
            const clazz = isTag(elem) && elem.attribs['class'];
            let idx = -1;
            if (clazz && className.length) {
                while ((idx = clazz.indexOf(className, idx + 1)) > -1) {
                    const end = idx + className.length;
                    if ((idx === 0 || rspace.test(clazz[idx - 1])) &&
                        (end === clazz.length || rspace.test(clazz[end]))) {
                        return true;
                    }
                }
            }
            return false;
        });
    }
    /**
     * Adds class(es) to all of the matched elements. Also accepts a `function`.
     *
     * @category Attributes
     * @example
     *
     * ```js
     * $('.pear').addClass('fruit').html();
     * //=> <li class="pear fruit">Pear</li>
     *
     * $('.apple').addClass('fruit red').html();
     * //=> <li class="apple fruit red">Apple</li>
     * ```
     *
     * @param value - Name of new class.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/addClass/}
     */
    function addClass(value) {
        // Support functions
        if (typeof value === 'function') {
            return domEach(this, (el, i) => {
                if (isTag(el)) {
                    const className = el.attribs['class'] || '';
                    addClass.call([el], value.call(el, i, className));
                }
            });
        }
        // Return if no value or not a string or function
        if (!value || typeof value !== 'string')
            return this;
        const classNames = value.split(rspace);
        const numElements = this.length;
        for (let i = 0; i < numElements; i++) {
            const el = this[i];
            // If selected element isn't a tag, move on
            if (!isTag(el))
                continue;
            // If we don't already have classes — always set xmlMode to false here, as it doesn't matter for classes
            const className = getAttr(el, 'class', false);
            if (!className) {
                setAttr(el, 'class', classNames.join(' ').trim());
            }
            else {
                let setClass = ` ${className} `;
                // Check if class already exists
                for (let j = 0; j < classNames.length; j++) {
                    const appendClass = `${classNames[j]} `;
                    if (!setClass.includes(` ${appendClass}`))
                        setClass += appendClass;
                }
                setAttr(el, 'class', setClass.trim());
            }
        }
        return this;
    }
    /**
     * Removes one or more space-separated classes from the selected elements. If no
     * `className` is defined, all classes will be removed. Also accepts a `function`.
     *
     * @category Attributes
     * @example
     *
     * ```js
     * $('.pear').removeClass('pear').html();
     * //=> <li class="">Pear</li>
     *
     * $('.apple').addClass('red').removeClass().html();
     * //=> <li class="">Apple</li>
     * ```
     *
     * @param name - Name of the class. If not specified, removes all elements.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/removeClass/}
     */
    function removeClass(name) {
        // Handle if value is a function
        if (typeof name === 'function') {
            return domEach(this, (el, i) => {
                if (isTag(el)) {
                    removeClass.call([el], name.call(el, i, el.attribs['class'] || ''));
                }
            });
        }
        const classes = splitNames(name);
        const numClasses = classes.length;
        const removeAll = arguments.length === 0;
        return domEach(this, (el) => {
            if (!isTag(el))
                return;
            if (removeAll) {
                // Short circuit the remove all case as this is the nice one
                el.attribs['class'] = '';
            }
            else {
                const elClasses = splitNames(el.attribs['class']);
                let changed = false;
                for (let j = 0; j < numClasses; j++) {
                    const index = elClasses.indexOf(classes[j]);
                    if (index >= 0) {
                        elClasses.splice(index, 1);
                        changed = true;
                        /*
                         * We have to do another pass to ensure that there are not duplicate
                         * classes listed
                         */
                        j--;
                    }
                }
                if (changed) {
                    el.attribs['class'] = elClasses.join(' ');
                }
            }
        });
    }
    /**
     * Add or remove class(es) from the matched elements, depending on either the
     * class's presence or the value of the switch argument. Also accepts a `function`.
     *
     * @category Attributes
     * @example
     *
     * ```js
     * $('.apple.green').toggleClass('fruit green red').html();
     * //=> <li class="apple fruit red">Apple</li>
     *
     * $('.apple.green').toggleClass('fruit green red', true).html();
     * //=> <li class="apple green fruit red">Apple</li>
     * ```
     *
     * @param value - Name of the class. Can also be a function.
     * @param stateVal - If specified the state of the class.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/toggleClass/}
     */
    function toggleClass(value, stateVal) {
        // Support functions
        if (typeof value === 'function') {
            return domEach(this, (el, i) => {
                if (isTag(el)) {
                    toggleClass.call([el], value.call(el, i, el.attribs['class'] || '', stateVal), stateVal);
                }
            });
        }
        // Return if no value or not a string or function
        if (!value || typeof value !== 'string')
            return this;
        const classNames = value.split(rspace);
        const numClasses = classNames.length;
        const state = typeof stateVal === 'boolean' ? (stateVal ? 1 : -1) : 0;
        const numElements = this.length;
        for (let i = 0; i < numElements; i++) {
            const el = this[i];
            // If selected element isn't a tag, move on
            if (!isTag(el))
                continue;
            const elementClasses = splitNames(el.attribs['class']);
            // Check if class already exists
            for (let j = 0; j < numClasses; j++) {
                // Check if the class name is currently defined
                const index = elementClasses.indexOf(classNames[j]);
                // Add if stateValue === true or we are toggling and there is no value
                if (state >= 0 && index < 0) {
                    elementClasses.push(classNames[j]);
                }
                else if (state <= 0 && index >= 0) {
                    // Otherwise remove but only if the item exists
                    elementClasses.splice(index, 1);
                }
            }
            el.attribs['class'] = elementClasses.join(' ');
        }
        return this;
    }

    var Attributes = /*#__PURE__*/Object.freeze({
        __proto__: null,
        attr: attr,
        prop: prop,
        data: data,
        val: val,
        removeAttr: removeAttr,
        hasClass: hasClass,
        addClass: addClass,
        removeClass: removeClass,
        toggleClass: toggleClass
    });

    var SelectorType;
    (function (SelectorType) {
        SelectorType["Attribute"] = "attribute";
        SelectorType["Pseudo"] = "pseudo";
        SelectorType["PseudoElement"] = "pseudo-element";
        SelectorType["Tag"] = "tag";
        SelectorType["Universal"] = "universal";
        // Traversals
        SelectorType["Adjacent"] = "adjacent";
        SelectorType["Child"] = "child";
        SelectorType["Descendant"] = "descendant";
        SelectorType["Parent"] = "parent";
        SelectorType["Sibling"] = "sibling";
        SelectorType["ColumnCombinator"] = "column-combinator";
    })(SelectorType || (SelectorType = {}));
    var AttributeAction;
    (function (AttributeAction) {
        AttributeAction["Any"] = "any";
        AttributeAction["Element"] = "element";
        AttributeAction["End"] = "end";
        AttributeAction["Equals"] = "equals";
        AttributeAction["Exists"] = "exists";
        AttributeAction["Hyphen"] = "hyphen";
        AttributeAction["Not"] = "not";
        AttributeAction["Start"] = "start";
    })(AttributeAction || (AttributeAction = {}));

    const reName = /^[^\\#]?(?:\\(?:[\da-f]{1,6}\s?|.)|[\w\-\u00b0-\uFFFF])+/;
    const reEscape = /\\([\da-f]{1,6}\s?|(\s)|.)/gi;
    const actionTypes = new Map([
        [126 /* Tilde */, AttributeAction.Element],
        [94 /* Circumflex */, AttributeAction.Start],
        [36 /* Dollar */, AttributeAction.End],
        [42 /* Asterisk */, AttributeAction.Any],
        [33 /* ExclamationMark */, AttributeAction.Not],
        [124 /* Pipe */, AttributeAction.Hyphen],
    ]);
    // Pseudos, whose data property is parsed as well.
    const unpackPseudos = new Set([
        "has",
        "not",
        "matches",
        "is",
        "where",
        "host",
        "host-context",
    ]);
    /**
     * Checks whether a specific selector is a traversal.
     * This is useful eg. in swapping the order of elements that
     * are not traversals.
     *
     * @param selector Selector to check.
     */
    function isTraversal$1(selector) {
        switch (selector.type) {
            case SelectorType.Adjacent:
            case SelectorType.Child:
            case SelectorType.Descendant:
            case SelectorType.Parent:
            case SelectorType.Sibling:
            case SelectorType.ColumnCombinator:
                return true;
            default:
                return false;
        }
    }
    const stripQuotesFromPseudos = new Set(["contains", "icontains"]);
    // Unescape function taken from https://github.com/jquery/sizzle/blob/master/src/sizzle.js#L152
    function funescape(_, escaped, escapedWhitespace) {
        const high = parseInt(escaped, 16) - 0x10000;
        // NaN means non-codepoint
        return high !== high || escapedWhitespace
            ? escaped
            : high < 0
                ? // BMP codepoint
                    String.fromCharCode(high + 0x10000)
                : // Supplemental Plane codepoint (surrogate pair)
                    String.fromCharCode((high >> 10) | 0xd800, (high & 0x3ff) | 0xdc00);
    }
    function unescapeCSS(str) {
        return str.replace(reEscape, funescape);
    }
    function isQuote(c) {
        return c === 39 /* SingleQuote */ || c === 34 /* DoubleQuote */;
    }
    function isWhitespace$2(c) {
        return (c === 32 /* Space */ ||
            c === 9 /* Tab */ ||
            c === 10 /* NewLine */ ||
            c === 12 /* FormFeed */ ||
            c === 13 /* CarriageReturn */);
    }
    /**
     * Parses `selector`, optionally with the passed `options`.
     *
     * @param selector Selector to parse.
     * @param options Options for parsing.
     * @returns Returns a two-dimensional array.
     * The first dimension represents selectors separated by commas (eg. `sub1, sub2`),
     * the second contains the relevant tokens for that selector.
     */
    function parse$4(selector) {
        const subselects = [];
        const endIndex = parseSelector(subselects, `${selector}`, 0);
        if (endIndex < selector.length) {
            throw new Error(`Unmatched selector: ${selector.slice(endIndex)}`);
        }
        return subselects;
    }
    function parseSelector(subselects, selector, selectorIndex) {
        let tokens = [];
        function getName(offset) {
            const match = selector.slice(selectorIndex + offset).match(reName);
            if (!match) {
                throw new Error(`Expected name, found ${selector.slice(selectorIndex)}`);
            }
            const [name] = match;
            selectorIndex += offset + name.length;
            return unescapeCSS(name);
        }
        function stripWhitespace(offset) {
            selectorIndex += offset;
            while (selectorIndex < selector.length &&
                isWhitespace$2(selector.charCodeAt(selectorIndex))) {
                selectorIndex++;
            }
        }
        function readValueWithParenthesis() {
            selectorIndex += 1;
            const start = selectorIndex;
            let counter = 1;
            for (; counter > 0 && selectorIndex < selector.length; selectorIndex++) {
                if (selector.charCodeAt(selectorIndex) ===
                    40 /* LeftParenthesis */ &&
                    !isEscaped(selectorIndex)) {
                    counter++;
                }
                else if (selector.charCodeAt(selectorIndex) ===
                    41 /* RightParenthesis */ &&
                    !isEscaped(selectorIndex)) {
                    counter--;
                }
            }
            if (counter) {
                throw new Error("Parenthesis not matched");
            }
            return unescapeCSS(selector.slice(start, selectorIndex - 1));
        }
        function isEscaped(pos) {
            let slashCount = 0;
            while (selector.charCodeAt(--pos) === 92 /* BackSlash */)
                slashCount++;
            return (slashCount & 1) === 1;
        }
        function ensureNotTraversal() {
            if (tokens.length > 0 && isTraversal$1(tokens[tokens.length - 1])) {
                throw new Error("Did not expect successive traversals.");
            }
        }
        function addTraversal(type) {
            if (tokens.length > 0 &&
                tokens[tokens.length - 1].type === SelectorType.Descendant) {
                tokens[tokens.length - 1].type = type;
                return;
            }
            ensureNotTraversal();
            tokens.push({ type });
        }
        function addSpecialAttribute(name, action) {
            tokens.push({
                type: SelectorType.Attribute,
                name,
                action,
                value: getName(1),
                namespace: null,
                ignoreCase: "quirks",
            });
        }
        /**
         * We have finished parsing the current part of the selector.
         *
         * Remove descendant tokens at the end if they exist,
         * and return the last index, so that parsing can be
         * picked up from here.
         */
        function finalizeSubselector() {
            if (tokens.length &&
                tokens[tokens.length - 1].type === SelectorType.Descendant) {
                tokens.pop();
            }
            if (tokens.length === 0) {
                throw new Error("Empty sub-selector");
            }
            subselects.push(tokens);
        }
        stripWhitespace(0);
        if (selector.length === selectorIndex) {
            return selectorIndex;
        }
        loop: while (selectorIndex < selector.length) {
            const firstChar = selector.charCodeAt(selectorIndex);
            switch (firstChar) {
                // Whitespace
                case 32 /* Space */:
                case 9 /* Tab */:
                case 10 /* NewLine */:
                case 12 /* FormFeed */:
                case 13 /* CarriageReturn */: {
                    if (tokens.length === 0 ||
                        tokens[0].type !== SelectorType.Descendant) {
                        ensureNotTraversal();
                        tokens.push({ type: SelectorType.Descendant });
                    }
                    stripWhitespace(1);
                    break;
                }
                // Traversals
                case 62 /* GreaterThan */: {
                    addTraversal(SelectorType.Child);
                    stripWhitespace(1);
                    break;
                }
                case 60 /* LessThan */: {
                    addTraversal(SelectorType.Parent);
                    stripWhitespace(1);
                    break;
                }
                case 126 /* Tilde */: {
                    addTraversal(SelectorType.Sibling);
                    stripWhitespace(1);
                    break;
                }
                case 43 /* Plus */: {
                    addTraversal(SelectorType.Adjacent);
                    stripWhitespace(1);
                    break;
                }
                // Special attribute selectors: .class, #id
                case 46 /* Period */: {
                    addSpecialAttribute("class", AttributeAction.Element);
                    break;
                }
                case 35 /* Hash */: {
                    addSpecialAttribute("id", AttributeAction.Equals);
                    break;
                }
                case 91 /* LeftSquareBracket */: {
                    stripWhitespace(1);
                    // Determine attribute name and namespace
                    let name;
                    let namespace = null;
                    if (selector.charCodeAt(selectorIndex) === 124 /* Pipe */) {
                        // Equivalent to no namespace
                        name = getName(1);
                    }
                    else if (selector.startsWith("*|", selectorIndex)) {
                        namespace = "*";
                        name = getName(2);
                    }
                    else {
                        name = getName(0);
                        if (selector.charCodeAt(selectorIndex) === 124 /* Pipe */ &&
                            selector.charCodeAt(selectorIndex + 1) !==
                                61 /* Equal */) {
                            namespace = name;
                            name = getName(1);
                        }
                    }
                    stripWhitespace(0);
                    // Determine comparison operation
                    let action = AttributeAction.Exists;
                    const possibleAction = actionTypes.get(selector.charCodeAt(selectorIndex));
                    if (possibleAction) {
                        action = possibleAction;
                        if (selector.charCodeAt(selectorIndex + 1) !==
                            61 /* Equal */) {
                            throw new Error("Expected `=`");
                        }
                        stripWhitespace(2);
                    }
                    else if (selector.charCodeAt(selectorIndex) === 61 /* Equal */) {
                        action = AttributeAction.Equals;
                        stripWhitespace(1);
                    }
                    // Determine value
                    let value = "";
                    let ignoreCase = null;
                    if (action !== "exists") {
                        if (isQuote(selector.charCodeAt(selectorIndex))) {
                            const quote = selector.charCodeAt(selectorIndex);
                            let sectionEnd = selectorIndex + 1;
                            while (sectionEnd < selector.length &&
                                (selector.charCodeAt(sectionEnd) !== quote ||
                                    isEscaped(sectionEnd))) {
                                sectionEnd += 1;
                            }
                            if (selector.charCodeAt(sectionEnd) !== quote) {
                                throw new Error("Attribute value didn't end");
                            }
                            value = unescapeCSS(selector.slice(selectorIndex + 1, sectionEnd));
                            selectorIndex = sectionEnd + 1;
                        }
                        else {
                            const valueStart = selectorIndex;
                            while (selectorIndex < selector.length &&
                                ((!isWhitespace$2(selector.charCodeAt(selectorIndex)) &&
                                    selector.charCodeAt(selectorIndex) !==
                                        93 /* RightSquareBracket */) ||
                                    isEscaped(selectorIndex))) {
                                selectorIndex += 1;
                            }
                            value = unescapeCSS(selector.slice(valueStart, selectorIndex));
                        }
                        stripWhitespace(0);
                        // See if we have a force ignore flag
                        const forceIgnore = selector.charCodeAt(selectorIndex) | 0x20;
                        // If the forceIgnore flag is set (either `i` or `s`), use that value
                        if (forceIgnore === 115 /* LowerS */) {
                            ignoreCase = false;
                            stripWhitespace(1);
                        }
                        else if (forceIgnore === 105 /* LowerI */) {
                            ignoreCase = true;
                            stripWhitespace(1);
                        }
                    }
                    if (selector.charCodeAt(selectorIndex) !==
                        93 /* RightSquareBracket */) {
                        throw new Error("Attribute selector didn't terminate");
                    }
                    selectorIndex += 1;
                    const attributeSelector = {
                        type: SelectorType.Attribute,
                        name,
                        action,
                        value,
                        namespace,
                        ignoreCase,
                    };
                    tokens.push(attributeSelector);
                    break;
                }
                case 58 /* Colon */: {
                    if (selector.charCodeAt(selectorIndex + 1) === 58 /* Colon */) {
                        tokens.push({
                            type: SelectorType.PseudoElement,
                            name: getName(2).toLowerCase(),
                            data: selector.charCodeAt(selectorIndex) ===
                                40 /* LeftParenthesis */
                                ? readValueWithParenthesis()
                                : null,
                        });
                        continue;
                    }
                    const name = getName(1).toLowerCase();
                    let data = null;
                    if (selector.charCodeAt(selectorIndex) ===
                        40 /* LeftParenthesis */) {
                        if (unpackPseudos.has(name)) {
                            if (isQuote(selector.charCodeAt(selectorIndex + 1))) {
                                throw new Error(`Pseudo-selector ${name} cannot be quoted`);
                            }
                            data = [];
                            selectorIndex = parseSelector(data, selector, selectorIndex + 1);
                            if (selector.charCodeAt(selectorIndex) !==
                                41 /* RightParenthesis */) {
                                throw new Error(`Missing closing parenthesis in :${name} (${selector})`);
                            }
                            selectorIndex += 1;
                        }
                        else {
                            data = readValueWithParenthesis();
                            if (stripQuotesFromPseudos.has(name)) {
                                const quot = data.charCodeAt(0);
                                if (quot === data.charCodeAt(data.length - 1) &&
                                    isQuote(quot)) {
                                    data = data.slice(1, -1);
                                }
                            }
                            data = unescapeCSS(data);
                        }
                    }
                    tokens.push({ type: SelectorType.Pseudo, name, data });
                    break;
                }
                case 44 /* Comma */: {
                    finalizeSubselector();
                    tokens = [];
                    stripWhitespace(1);
                    break;
                }
                default: {
                    if (selector.startsWith("/*", selectorIndex)) {
                        const endIndex = selector.indexOf("*/", selectorIndex + 2);
                        if (endIndex < 0) {
                            throw new Error("Comment was not terminated");
                        }
                        selectorIndex = endIndex + 2;
                        // Remove leading whitespace
                        if (tokens.length === 0) {
                            stripWhitespace(0);
                        }
                        break;
                    }
                    let namespace = null;
                    let name;
                    if (firstChar === 42 /* Asterisk */) {
                        selectorIndex += 1;
                        name = "*";
                    }
                    else if (firstChar === 124 /* Pipe */) {
                        name = "";
                        if (selector.charCodeAt(selectorIndex + 1) === 124 /* Pipe */) {
                            addTraversal(SelectorType.ColumnCombinator);
                            stripWhitespace(2);
                            break;
                        }
                    }
                    else if (reName.test(selector.slice(selectorIndex))) {
                        name = getName(0);
                    }
                    else {
                        break loop;
                    }
                    if (selector.charCodeAt(selectorIndex) === 124 /* Pipe */ &&
                        selector.charCodeAt(selectorIndex + 1) !== 124 /* Pipe */) {
                        namespace = name;
                        if (selector.charCodeAt(selectorIndex + 1) ===
                            42 /* Asterisk */) {
                            name = "*";
                            selectorIndex += 2;
                        }
                        else {
                            name = getName(1);
                        }
                    }
                    tokens.push(name === "*"
                        ? { type: SelectorType.Universal, namespace }
                        : { type: SelectorType.Tag, name, namespace });
                }
            }
        }
        finalizeSubselector();
        return selectorIndex;
    }

    var boolbase = {
    	trueFunc: function trueFunc(){
    		return true;
    	},
    	falseFunc: function falseFunc(){
    		return false;
    	}
    };

    const procedure = new Map([
        [SelectorType.Universal, 50],
        [SelectorType.Tag, 30],
        [SelectorType.Attribute, 1],
        [SelectorType.Pseudo, 0],
    ]);
    function isTraversal(token) {
        return !procedure.has(token.type);
    }
    const attributes = new Map([
        [AttributeAction.Exists, 10],
        [AttributeAction.Equals, 8],
        [AttributeAction.Not, 7],
        [AttributeAction.Start, 6],
        [AttributeAction.End, 6],
        [AttributeAction.Any, 5],
    ]);
    /**
     * Sort the parts of the passed selector,
     * as there is potential for optimization
     * (some types of selectors are faster than others)
     *
     * @param arr Selector to sort
     */
    function sortByProcedure(arr) {
        const procs = arr.map(getProcedure);
        for (let i = 1; i < arr.length; i++) {
            const procNew = procs[i];
            if (procNew < 0)
                continue;
            for (let j = i - 1; j >= 0 && procNew < procs[j]; j--) {
                const token = arr[j + 1];
                arr[j + 1] = arr[j];
                arr[j] = token;
                procs[j + 1] = procs[j];
                procs[j] = procNew;
            }
        }
    }
    function getProcedure(token) {
        var _a, _b;
        let proc = (_a = procedure.get(token.type)) !== null && _a !== void 0 ? _a : -1;
        if (token.type === SelectorType.Attribute) {
            proc = (_b = attributes.get(token.action)) !== null && _b !== void 0 ? _b : 4;
            if (token.action === AttributeAction.Equals && token.name === "id") {
                // Prefer ID selectors (eg. #ID)
                proc = 9;
            }
            if (token.ignoreCase) {
                /*
                 * IgnoreCase adds some overhead, prefer "normal" token
                 * this is a binary operation, to ensure it's still an int
                 */
                proc >>= 1;
            }
        }
        else if (token.type === SelectorType.Pseudo) {
            if (!token.data) {
                proc = 3;
            }
            else if (token.name === "has" || token.name === "contains") {
                proc = 0; // Expensive in any case
            }
            else if (Array.isArray(token.data)) {
                // Eg. :matches, :not
                proc = Math.min(...token.data.map((d) => Math.min(...d.map(getProcedure))));
                // If we have traversals, try to avoid executing this selector
                if (proc < 0) {
                    proc = 0;
                }
            }
            else {
                proc = 2;
            }
        }
        return proc;
    }

    /**
     * All reserved characters in a regex, used for escaping.
     *
     * Taken from XRegExp, (c) 2007-2020 Steven Levithan under the MIT license
     * https://github.com/slevithan/xregexp/blob/95eeebeb8fac8754d54eafe2b4743661ac1cf028/src/xregexp.js#L794
     */
    const reChars = /[-[\]{}()*+?.,\\^$|#\s]/g;
    function escapeRegex(value) {
        return value.replace(reChars, "\\$&");
    }
    /**
     * Attributes that are case-insensitive in HTML.
     *
     * @private
     * @see https://html.spec.whatwg.org/multipage/semantics-other.html#case-sensitivity-of-selectors
     */
    const caseInsensitiveAttributes = new Set([
        "accept",
        "accept-charset",
        "align",
        "alink",
        "axis",
        "bgcolor",
        "charset",
        "checked",
        "clear",
        "codetype",
        "color",
        "compact",
        "declare",
        "defer",
        "dir",
        "direction",
        "disabled",
        "enctype",
        "face",
        "frame",
        "hreflang",
        "http-equiv",
        "lang",
        "language",
        "link",
        "media",
        "method",
        "multiple",
        "nohref",
        "noresize",
        "noshade",
        "nowrap",
        "readonly",
        "rel",
        "rev",
        "rules",
        "scope",
        "scrolling",
        "selected",
        "shape",
        "target",
        "text",
        "type",
        "valign",
        "valuetype",
        "vlink",
    ]);
    function shouldIgnoreCase(selector, options) {
        return typeof selector.ignoreCase === "boolean"
            ? selector.ignoreCase
            : selector.ignoreCase === "quirks"
                ? !!options.quirksMode
                : !options.xmlMode && caseInsensitiveAttributes.has(selector.name);
    }
    /**
     * Attribute selectors
     */
    const attributeRules = {
        equals(next, data, options) {
            const { adapter } = options;
            const { name } = data;
            let { value } = data;
            if (shouldIgnoreCase(data, options)) {
                value = value.toLowerCase();
                return (elem) => {
                    const attr = adapter.getAttributeValue(elem, name);
                    return (attr != null &&
                        attr.length === value.length &&
                        attr.toLowerCase() === value &&
                        next(elem));
                };
            }
            return (elem) => adapter.getAttributeValue(elem, name) === value && next(elem);
        },
        hyphen(next, data, options) {
            const { adapter } = options;
            const { name } = data;
            let { value } = data;
            const len = value.length;
            if (shouldIgnoreCase(data, options)) {
                value = value.toLowerCase();
                return function hyphenIC(elem) {
                    const attr = adapter.getAttributeValue(elem, name);
                    return (attr != null &&
                        (attr.length === len || attr.charAt(len) === "-") &&
                        attr.substr(0, len).toLowerCase() === value &&
                        next(elem));
                };
            }
            return function hyphen(elem) {
                const attr = adapter.getAttributeValue(elem, name);
                return (attr != null &&
                    (attr.length === len || attr.charAt(len) === "-") &&
                    attr.substr(0, len) === value &&
                    next(elem));
            };
        },
        element(next, data, options) {
            const { adapter } = options;
            const { name, value } = data;
            if (/\s/.test(value)) {
                return boolbase.falseFunc;
            }
            const regex = new RegExp(`(?:^|\\s)${escapeRegex(value)}(?:$|\\s)`, shouldIgnoreCase(data, options) ? "i" : "");
            return function element(elem) {
                const attr = adapter.getAttributeValue(elem, name);
                return (attr != null &&
                    attr.length >= value.length &&
                    regex.test(attr) &&
                    next(elem));
            };
        },
        exists(next, { name }, { adapter }) {
            return (elem) => adapter.hasAttrib(elem, name) && next(elem);
        },
        start(next, data, options) {
            const { adapter } = options;
            const { name } = data;
            let { value } = data;
            const len = value.length;
            if (len === 0) {
                return boolbase.falseFunc;
            }
            if (shouldIgnoreCase(data, options)) {
                value = value.toLowerCase();
                return (elem) => {
                    const attr = adapter.getAttributeValue(elem, name);
                    return (attr != null &&
                        attr.length >= len &&
                        attr.substr(0, len).toLowerCase() === value &&
                        next(elem));
                };
            }
            return (elem) => {
                var _a;
                return !!((_a = adapter.getAttributeValue(elem, name)) === null || _a === void 0 ? void 0 : _a.startsWith(value)) &&
                    next(elem);
            };
        },
        end(next, data, options) {
            const { adapter } = options;
            const { name } = data;
            let { value } = data;
            const len = -value.length;
            if (len === 0) {
                return boolbase.falseFunc;
            }
            if (shouldIgnoreCase(data, options)) {
                value = value.toLowerCase();
                return (elem) => {
                    var _a;
                    return ((_a = adapter
                        .getAttributeValue(elem, name)) === null || _a === void 0 ? void 0 : _a.substr(len).toLowerCase()) === value && next(elem);
                };
            }
            return (elem) => {
                var _a;
                return !!((_a = adapter.getAttributeValue(elem, name)) === null || _a === void 0 ? void 0 : _a.endsWith(value)) &&
                    next(elem);
            };
        },
        any(next, data, options) {
            const { adapter } = options;
            const { name, value } = data;
            if (value === "") {
                return boolbase.falseFunc;
            }
            if (shouldIgnoreCase(data, options)) {
                const regex = new RegExp(escapeRegex(value), "i");
                return function anyIC(elem) {
                    const attr = adapter.getAttributeValue(elem, name);
                    return (attr != null &&
                        attr.length >= value.length &&
                        regex.test(attr) &&
                        next(elem));
                };
            }
            return (elem) => {
                var _a;
                return !!((_a = adapter.getAttributeValue(elem, name)) === null || _a === void 0 ? void 0 : _a.includes(value)) &&
                    next(elem);
            };
        },
        not(next, data, options) {
            const { adapter } = options;
            const { name } = data;
            let { value } = data;
            if (value === "") {
                return (elem) => !!adapter.getAttributeValue(elem, name) && next(elem);
            }
            else if (shouldIgnoreCase(data, options)) {
                value = value.toLowerCase();
                return (elem) => {
                    const attr = adapter.getAttributeValue(elem, name);
                    return ((attr == null ||
                        attr.length !== value.length ||
                        attr.toLowerCase() !== value) &&
                        next(elem));
                };
            }
            return (elem) => adapter.getAttributeValue(elem, name) !== value && next(elem);
        },
    };

    // Following http://www.w3.org/TR/css3-selectors/#nth-child-pseudo
    // Whitespace as per https://www.w3.org/TR/selectors-3/#lex is " \t\r\n\f"
    const whitespace = new Set([9, 10, 12, 13, 32]);
    const ZERO = "0".charCodeAt(0);
    const NINE = "9".charCodeAt(0);
    /**
     * Parses an expression.
     *
     * @throws An `Error` if parsing fails.
     * @returns An array containing the integer step size and the integer offset of the nth rule.
     * @example nthCheck.parse("2n+3"); // returns [2, 3]
     */
    function parse$3(formula) {
        formula = formula.trim().toLowerCase();
        if (formula === "even") {
            return [2, 0];
        }
        else if (formula === "odd") {
            return [2, 1];
        }
        // Parse [ ['-'|'+']? INTEGER? {N} [ S* ['-'|'+'] S* INTEGER ]?
        let idx = 0;
        let a = 0;
        let sign = readSign();
        let number = readNumber();
        if (idx < formula.length && formula.charAt(idx) === "n") {
            idx++;
            a = sign * (number !== null && number !== void 0 ? number : 1);
            skipWhitespace();
            if (idx < formula.length) {
                sign = readSign();
                skipWhitespace();
                number = readNumber();
            }
            else {
                sign = number = 0;
            }
        }
        // Throw if there is anything else
        if (number === null || idx < formula.length) {
            throw new Error(`n-th rule couldn't be parsed ('${formula}')`);
        }
        return [a, sign * number];
        function readSign() {
            if (formula.charAt(idx) === "-") {
                idx++;
                return -1;
            }
            if (formula.charAt(idx) === "+") {
                idx++;
            }
            return 1;
        }
        function readNumber() {
            const start = idx;
            let value = 0;
            while (idx < formula.length &&
                formula.charCodeAt(idx) >= ZERO &&
                formula.charCodeAt(idx) <= NINE) {
                value = value * 10 + (formula.charCodeAt(idx) - ZERO);
                idx++;
            }
            // Return `null` if we didn't read anything.
            return idx === start ? null : value;
        }
        function skipWhitespace() {
            while (idx < formula.length &&
                whitespace.has(formula.charCodeAt(idx))) {
                idx++;
            }
        }
    }

    /**
     * Returns a function that checks if an elements index matches the given rule
     * highly optimized to return the fastest solution.
     *
     * @param parsed A tuple [a, b], as returned by `parse`.
     * @returns A highly optimized function that returns whether an index matches the nth-check.
     * @example
     *
     * ```js
     * const check = nthCheck.compile([2, 3]);
     *
     * check(0); // `false`
     * check(1); // `false`
     * check(2); // `true`
     * check(3); // `false`
     * check(4); // `true`
     * check(5); // `false`
     * check(6); // `true`
     * ```
     */
    function compile(parsed) {
        const a = parsed[0];
        // Subtract 1 from `b`, to convert from one- to zero-indexed.
        const b = parsed[1] - 1;
        /*
         * When `b <= 0`, `a * n` won't be lead to any matches for `a < 0`.
         * Besides, the specification states that no elements are
         * matched when `a` and `b` are 0.
         *
         * `b < 0` here as we subtracted 1 from `b` above.
         */
        if (b < 0 && a <= 0)
            return boolbase.falseFunc;
        // When `a` is in the range -1..1, it matches any element (so only `b` is checked).
        if (a === -1)
            return (index) => index <= b;
        if (a === 0)
            return (index) => index === b;
        // When `b <= 0` and `a === 1`, they match any element.
        if (a === 1)
            return b < 0 ? boolbase.trueFunc : (index) => index >= b;
        /*
         * Otherwise, modulo can be used to check if there is a match.
         *
         * Modulo doesn't care about the sign, so let's use `a`s absolute value.
         */
        const absA = Math.abs(a);
        // Get `b mod a`, + a if this is negative.
        const bMod = ((b % absA) + absA) % absA;
        return a > 1
            ? (index) => index >= b && index % absA === bMod
            : (index) => index <= b && index % absA === bMod;
    }

    /**
     * Parses and compiles a formula to a highly optimized function.
     * Combination of {@link parse} and {@link compile}.
     *
     * If the formula doesn't match any elements,
     * it returns [`boolbase`](https://github.com/fb55/boolbase)'s `falseFunc`.
     * Otherwise, a function accepting an _index_ is returned, which returns
     * whether or not the passed _index_ matches the formula.
     *
     * Note: The nth-rule starts counting at `1`, the returned function at `0`.
     *
     * @param formula The formula to compile.
     * @example
     * const check = nthCheck("2n+3");
     *
     * check(0); // `false`
     * check(1); // `false`
     * check(2); // `true`
     * check(3); // `false`
     * check(4); // `true`
     * check(5); // `false`
     * check(6); // `true`
     */
    function nthCheck(formula) {
        return compile(parse$3(formula));
    }

    function getChildFunc(next, adapter) {
        return (elem) => {
            const parent = adapter.getParent(elem);
            return parent != null && adapter.isTag(parent) && next(elem);
        };
    }
    const filters = {
        contains(next, text, { adapter }) {
            return function contains(elem) {
                return next(elem) && adapter.getText(elem).includes(text);
            };
        },
        icontains(next, text, { adapter }) {
            const itext = text.toLowerCase();
            return function icontains(elem) {
                return (next(elem) &&
                    adapter.getText(elem).toLowerCase().includes(itext));
            };
        },
        // Location specific methods
        "nth-child"(next, rule, { adapter, equals }) {
            const func = nthCheck(rule);
            if (func === boolbase.falseFunc)
                return boolbase.falseFunc;
            if (func === boolbase.trueFunc)
                return getChildFunc(next, adapter);
            return function nthChild(elem) {
                const siblings = adapter.getSiblings(elem);
                let pos = 0;
                for (let i = 0; i < siblings.length; i++) {
                    if (equals(elem, siblings[i]))
                        break;
                    if (adapter.isTag(siblings[i])) {
                        pos++;
                    }
                }
                return func(pos) && next(elem);
            };
        },
        "nth-last-child"(next, rule, { adapter, equals }) {
            const func = nthCheck(rule);
            if (func === boolbase.falseFunc)
                return boolbase.falseFunc;
            if (func === boolbase.trueFunc)
                return getChildFunc(next, adapter);
            return function nthLastChild(elem) {
                const siblings = adapter.getSiblings(elem);
                let pos = 0;
                for (let i = siblings.length - 1; i >= 0; i--) {
                    if (equals(elem, siblings[i]))
                        break;
                    if (adapter.isTag(siblings[i])) {
                        pos++;
                    }
                }
                return func(pos) && next(elem);
            };
        },
        "nth-of-type"(next, rule, { adapter, equals }) {
            const func = nthCheck(rule);
            if (func === boolbase.falseFunc)
                return boolbase.falseFunc;
            if (func === boolbase.trueFunc)
                return getChildFunc(next, adapter);
            return function nthOfType(elem) {
                const siblings = adapter.getSiblings(elem);
                let pos = 0;
                for (let i = 0; i < siblings.length; i++) {
                    const currentSibling = siblings[i];
                    if (equals(elem, currentSibling))
                        break;
                    if (adapter.isTag(currentSibling) &&
                        adapter.getName(currentSibling) === adapter.getName(elem)) {
                        pos++;
                    }
                }
                return func(pos) && next(elem);
            };
        },
        "nth-last-of-type"(next, rule, { adapter, equals }) {
            const func = nthCheck(rule);
            if (func === boolbase.falseFunc)
                return boolbase.falseFunc;
            if (func === boolbase.trueFunc)
                return getChildFunc(next, adapter);
            return function nthLastOfType(elem) {
                const siblings = adapter.getSiblings(elem);
                let pos = 0;
                for (let i = siblings.length - 1; i >= 0; i--) {
                    const currentSibling = siblings[i];
                    if (equals(elem, currentSibling))
                        break;
                    if (adapter.isTag(currentSibling) &&
                        adapter.getName(currentSibling) === adapter.getName(elem)) {
                        pos++;
                    }
                }
                return func(pos) && next(elem);
            };
        },
        // TODO determine the actual root element
        root(next, _rule, { adapter }) {
            return (elem) => {
                const parent = adapter.getParent(elem);
                return (parent == null || !adapter.isTag(parent)) && next(elem);
            };
        },
        scope(next, rule, options, context) {
            const { equals } = options;
            if (!context || context.length === 0) {
                // Equivalent to :root
                return filters["root"](next, rule, options);
            }
            if (context.length === 1) {
                // NOTE: can't be unpacked, as :has uses this for side-effects
                return (elem) => equals(context[0], elem) && next(elem);
            }
            return (elem) => context.includes(elem) && next(elem);
        },
        hover: dynamicStatePseudo("isHovered"),
        visited: dynamicStatePseudo("isVisited"),
        active: dynamicStatePseudo("isActive"),
    };
    /**
     * Dynamic state pseudos. These depend on optional Adapter methods.
     *
     * @param name The name of the adapter method to call.
     * @returns Pseudo for the `filters` object.
     */
    function dynamicStatePseudo(name) {
        return function dynamicPseudo(next, _rule, { adapter }) {
            const func = adapter[name];
            if (typeof func !== "function") {
                return boolbase.falseFunc;
            }
            return function active(elem) {
                return func(elem) && next(elem);
            };
        };
    }

    // While filters are precompiled, pseudos get called when they are needed
    const pseudos = {
        empty(elem, { adapter }) {
            return !adapter.getChildren(elem).some((elem) => 
            // FIXME: `getText` call is potentially expensive.
            adapter.isTag(elem) || adapter.getText(elem) !== "");
        },
        "first-child"(elem, { adapter, equals }) {
            if (adapter.prevElementSibling) {
                return adapter.prevElementSibling(elem) == null;
            }
            const firstChild = adapter
                .getSiblings(elem)
                .find((elem) => adapter.isTag(elem));
            return firstChild != null && equals(elem, firstChild);
        },
        "last-child"(elem, { adapter, equals }) {
            const siblings = adapter.getSiblings(elem);
            for (let i = siblings.length - 1; i >= 0; i--) {
                if (equals(elem, siblings[i]))
                    return true;
                if (adapter.isTag(siblings[i]))
                    break;
            }
            return false;
        },
        "first-of-type"(elem, { adapter, equals }) {
            const siblings = adapter.getSiblings(elem);
            const elemName = adapter.getName(elem);
            for (let i = 0; i < siblings.length; i++) {
                const currentSibling = siblings[i];
                if (equals(elem, currentSibling))
                    return true;
                if (adapter.isTag(currentSibling) &&
                    adapter.getName(currentSibling) === elemName) {
                    break;
                }
            }
            return false;
        },
        "last-of-type"(elem, { adapter, equals }) {
            const siblings = adapter.getSiblings(elem);
            const elemName = adapter.getName(elem);
            for (let i = siblings.length - 1; i >= 0; i--) {
                const currentSibling = siblings[i];
                if (equals(elem, currentSibling))
                    return true;
                if (adapter.isTag(currentSibling) &&
                    adapter.getName(currentSibling) === elemName) {
                    break;
                }
            }
            return false;
        },
        "only-of-type"(elem, { adapter, equals }) {
            const elemName = adapter.getName(elem);
            return adapter
                .getSiblings(elem)
                .every((sibling) => equals(elem, sibling) ||
                !adapter.isTag(sibling) ||
                adapter.getName(sibling) !== elemName);
        },
        "only-child"(elem, { adapter, equals }) {
            return adapter
                .getSiblings(elem)
                .every((sibling) => equals(elem, sibling) || !adapter.isTag(sibling));
        },
    };
    function verifyPseudoArgs(func, name, subselect, argIndex) {
        if (subselect === null) {
            if (func.length > argIndex) {
                throw new Error(`Pseudo-class :${name} requires an argument`);
            }
        }
        else if (func.length === argIndex) {
            throw new Error(`Pseudo-class :${name} doesn't have any arguments`);
        }
    }

    /**
     * Aliases are pseudos that are expressed as selectors.
     */
    const aliases = {
        // Links
        "any-link": ":is(a, area, link)[href]",
        link: ":any-link:not(:visited)",
        // Forms
        // https://html.spec.whatwg.org/multipage/scripting.html#disabled-elements
        disabled: `:is(
        :is(button, input, select, textarea, optgroup, option)[disabled],
        optgroup[disabled] > option,
        fieldset[disabled]:not(fieldset[disabled] legend:first-of-type *)
    )`,
        enabled: ":not(:disabled)",
        checked: ":is(:is(input[type=radio], input[type=checkbox])[checked], option:selected)",
        required: ":is(input, select, textarea)[required]",
        optional: ":is(input, select, textarea):not([required])",
        // JQuery extensions
        // https://html.spec.whatwg.org/multipage/form-elements.html#concept-option-selectedness
        selected: "option:is([selected], select:not([multiple]):not(:has(> option[selected])) > :first-of-type)",
        checkbox: "[type=checkbox]",
        file: "[type=file]",
        password: "[type=password]",
        radio: "[type=radio]",
        reset: "[type=reset]",
        image: "[type=image]",
        submit: "[type=submit]",
        parent: ":not(:empty)",
        header: ":is(h1, h2, h3, h4, h5, h6)",
        button: ":is(button, input[type=button])",
        input: ":is(input, textarea, select, button)",
        text: "input:is(:not([type!='']), [type=text])",
    };

    /** Used as a placeholder for :has. Will be replaced with the actual element. */
    const PLACEHOLDER_ELEMENT = {};
    function ensureIsTag(next, adapter) {
        if (next === boolbase.falseFunc)
            return boolbase.falseFunc;
        return (elem) => adapter.isTag(elem) && next(elem);
    }
    function getNextSiblings(elem, adapter) {
        const siblings = adapter.getSiblings(elem);
        if (siblings.length <= 1)
            return [];
        const elemIndex = siblings.indexOf(elem);
        if (elemIndex < 0 || elemIndex === siblings.length - 1)
            return [];
        return siblings.slice(elemIndex + 1).filter(adapter.isTag);
    }
    function copyOptions(options) {
        // Not copied: context, rootFunc
        return {
            xmlMode: !!options.xmlMode,
            lowerCaseAttributeNames: !!options.lowerCaseAttributeNames,
            lowerCaseTags: !!options.lowerCaseTags,
            quirksMode: !!options.quirksMode,
            cacheResults: !!options.cacheResults,
            pseudos: options.pseudos,
            adapter: options.adapter,
            equals: options.equals,
        };
    }
    const is$2 = (next, token, options, context, compileToken) => {
        const func = compileToken(token, copyOptions(options), context);
        return func === boolbase.trueFunc
            ? next
            : func === boolbase.falseFunc
                ? boolbase.falseFunc
                : (elem) => func(elem) && next(elem);
    };
    /*
     * :not, :has, :is, :matches and :where have to compile selectors
     * doing this in src/pseudos.ts would lead to circular dependencies,
     * so we add them here
     */
    const subselects = {
        is: is$2,
        /**
         * `:matches` and `:where` are aliases for `:is`.
         */
        matches: is$2,
        where: is$2,
        not(next, token, options, context, compileToken) {
            const func = compileToken(token, copyOptions(options), context);
            return func === boolbase.falseFunc
                ? next
                : func === boolbase.trueFunc
                    ? boolbase.falseFunc
                    : (elem) => !func(elem) && next(elem);
        },
        has(next, subselect, options, _context, compileToken) {
            const { adapter } = options;
            const opts = copyOptions(options);
            opts.relativeSelector = true;
            const context = subselect.some((s) => s.some(isTraversal))
                ? // Used as a placeholder. Will be replaced with the actual element.
                    [PLACEHOLDER_ELEMENT]
                : undefined;
            const compiled = compileToken(subselect, opts, context);
            if (compiled === boolbase.falseFunc)
                return boolbase.falseFunc;
            const hasElement = ensureIsTag(compiled, adapter);
            // If `compiled` is `trueFunc`, we can skip this.
            if (context && compiled !== boolbase.trueFunc) {
                /*
                 * `shouldTestNextSiblings` will only be true if the query starts with
                 * a traversal (sibling or adjacent). That means we will always have a context.
                 */
                const { shouldTestNextSiblings = false } = compiled;
                return (elem) => {
                    if (!next(elem))
                        return false;
                    context[0] = elem;
                    const childs = adapter.getChildren(elem);
                    const nextElements = shouldTestNextSiblings
                        ? [...childs, ...getNextSiblings(elem, adapter)]
                        : childs;
                    return adapter.existsOne(hasElement, nextElements);
                };
            }
            return (elem) => next(elem) &&
                adapter.existsOne(hasElement, adapter.getChildren(elem));
        },
    };

    function compilePseudoSelector(next, selector, options, context, compileToken) {
        var _a;
        const { name, data } = selector;
        if (Array.isArray(data)) {
            if (!(name in subselects)) {
                throw new Error(`Unknown pseudo-class :${name}(${data})`);
            }
            return subselects[name](next, data, options, context, compileToken);
        }
        const userPseudo = (_a = options.pseudos) === null || _a === void 0 ? void 0 : _a[name];
        const stringPseudo = typeof userPseudo === "string" ? userPseudo : aliases[name];
        if (typeof stringPseudo === "string") {
            if (data != null) {
                throw new Error(`Pseudo ${name} doesn't have any arguments`);
            }
            // The alias has to be parsed here, to make sure options are respected.
            const alias = parse$4(stringPseudo);
            return subselects["is"](next, alias, options, context, compileToken);
        }
        if (typeof userPseudo === "function") {
            verifyPseudoArgs(userPseudo, name, data, 1);
            return (elem) => userPseudo(elem, data) && next(elem);
        }
        if (name in filters) {
            return filters[name](next, data, options, context);
        }
        if (name in pseudos) {
            const pseudo = pseudos[name];
            verifyPseudoArgs(pseudo, name, data, 2);
            return (elem) => pseudo(elem, options, data) && next(elem);
        }
        throw new Error(`Unknown pseudo-class :${name}`);
    }

    function getElementParent(node, adapter) {
        const parent = adapter.getParent(node);
        if (parent && adapter.isTag(parent)) {
            return parent;
        }
        return null;
    }
    /*
     * All available rules
     */
    function compileGeneralSelector(next, selector, options, context, compileToken) {
        const { adapter, equals } = options;
        switch (selector.type) {
            case SelectorType.PseudoElement: {
                throw new Error("Pseudo-elements are not supported by css-select");
            }
            case SelectorType.ColumnCombinator: {
                throw new Error("Column combinators are not yet supported by css-select");
            }
            case SelectorType.Attribute: {
                if (selector.namespace != null) {
                    throw new Error("Namespaced attributes are not yet supported by css-select");
                }
                if (!options.xmlMode || options.lowerCaseAttributeNames) {
                    selector.name = selector.name.toLowerCase();
                }
                return attributeRules[selector.action](next, selector, options);
            }
            case SelectorType.Pseudo: {
                return compilePseudoSelector(next, selector, options, context, compileToken);
            }
            // Tags
            case SelectorType.Tag: {
                if (selector.namespace != null) {
                    throw new Error("Namespaced tag names are not yet supported by css-select");
                }
                let { name } = selector;
                if (!options.xmlMode || options.lowerCaseTags) {
                    name = name.toLowerCase();
                }
                return function tag(elem) {
                    return adapter.getName(elem) === name && next(elem);
                };
            }
            // Traversal
            case SelectorType.Descendant: {
                if (options.cacheResults === false ||
                    typeof WeakSet === "undefined") {
                    return function descendant(elem) {
                        let current = elem;
                        while ((current = getElementParent(current, adapter))) {
                            if (next(current)) {
                                return true;
                            }
                        }
                        return false;
                    };
                }
                // @ts-expect-error `ElementNode` is not extending object
                const isFalseCache = new WeakSet();
                return function cachedDescendant(elem) {
                    let current = elem;
                    while ((current = getElementParent(current, adapter))) {
                        if (!isFalseCache.has(current)) {
                            if (adapter.isTag(current) && next(current)) {
                                return true;
                            }
                            isFalseCache.add(current);
                        }
                    }
                    return false;
                };
            }
            case "_flexibleDescendant": {
                // Include element itself, only used while querying an array
                return function flexibleDescendant(elem) {
                    let current = elem;
                    do {
                        if (next(current))
                            return true;
                    } while ((current = getElementParent(current, adapter)));
                    return false;
                };
            }
            case SelectorType.Parent: {
                return function parent(elem) {
                    return adapter
                        .getChildren(elem)
                        .some((elem) => adapter.isTag(elem) && next(elem));
                };
            }
            case SelectorType.Child: {
                return function child(elem) {
                    const parent = adapter.getParent(elem);
                    return parent != null && adapter.isTag(parent) && next(parent);
                };
            }
            case SelectorType.Sibling: {
                return function sibling(elem) {
                    const siblings = adapter.getSiblings(elem);
                    for (let i = 0; i < siblings.length; i++) {
                        const currentSibling = siblings[i];
                        if (equals(elem, currentSibling))
                            break;
                        if (adapter.isTag(currentSibling) && next(currentSibling)) {
                            return true;
                        }
                    }
                    return false;
                };
            }
            case SelectorType.Adjacent: {
                if (adapter.prevElementSibling) {
                    return function adjacent(elem) {
                        const previous = adapter.prevElementSibling(elem);
                        return previous != null && next(previous);
                    };
                }
                return function adjacent(elem) {
                    const siblings = adapter.getSiblings(elem);
                    let lastElement;
                    for (let i = 0; i < siblings.length; i++) {
                        const currentSibling = siblings[i];
                        if (equals(elem, currentSibling))
                            break;
                        if (adapter.isTag(currentSibling)) {
                            lastElement = currentSibling;
                        }
                    }
                    return !!lastElement && next(lastElement);
                };
            }
            case SelectorType.Universal: {
                if (selector.namespace != null && selector.namespace !== "*") {
                    throw new Error("Namespaced universal selectors are not yet supported by css-select");
                }
                return next;
            }
        }
    }

    function includesScopePseudo(t) {
        return (t.type === SelectorType.Pseudo &&
            (t.name === "scope" ||
                (Array.isArray(t.data) &&
                    t.data.some((data) => data.some(includesScopePseudo)))));
    }
    const DESCENDANT_TOKEN = { type: SelectorType.Descendant };
    const FLEXIBLE_DESCENDANT_TOKEN = {
        type: "_flexibleDescendant",
    };
    const SCOPE_TOKEN = {
        type: SelectorType.Pseudo,
        name: "scope",
        data: null,
    };
    /*
     * CSS 4 Spec (Draft): 3.4.1. Absolutizing a Relative Selector
     * http://www.w3.org/TR/selectors4/#absolutizing
     */
    function absolutize(token, { adapter }, context) {
        // TODO Use better check if the context is a document
        const hasContext = !!(context === null || context === void 0 ? void 0 : context.every((e) => {
            const parent = adapter.isTag(e) && adapter.getParent(e);
            return e === PLACEHOLDER_ELEMENT || (parent && adapter.isTag(parent));
        }));
        for (const t of token) {
            if (t.length > 0 &&
                isTraversal(t[0]) &&
                t[0].type !== SelectorType.Descendant) ;
            else if (hasContext && !t.some(includesScopePseudo)) {
                t.unshift(DESCENDANT_TOKEN);
            }
            else {
                continue;
            }
            t.unshift(SCOPE_TOKEN);
        }
    }
    function compileToken(token, options, context) {
        var _a;
        token.forEach(sortByProcedure);
        context = (_a = options.context) !== null && _a !== void 0 ? _a : context;
        const isArrayContext = Array.isArray(context);
        const finalContext = context && (Array.isArray(context) ? context : [context]);
        // Check if the selector is relative
        if (options.relativeSelector !== false) {
            absolutize(token, options, finalContext);
        }
        else if (token.some((t) => t.length > 0 && isTraversal(t[0]))) {
            throw new Error("Relative selectors are not allowed when the `relativeSelector` option is disabled");
        }
        let shouldTestNextSiblings = false;
        const query = token
            .map((rules) => {
            if (rules.length >= 2) {
                const [first, second] = rules;
                if (first.type !== SelectorType.Pseudo ||
                    first.name !== "scope") ;
                else if (isArrayContext &&
                    second.type === SelectorType.Descendant) {
                    rules[1] = FLEXIBLE_DESCENDANT_TOKEN;
                }
                else if (second.type === SelectorType.Adjacent ||
                    second.type === SelectorType.Sibling) {
                    shouldTestNextSiblings = true;
                }
            }
            return compileRules(rules, options, finalContext);
        })
            .reduce(reduceRules, boolbase.falseFunc);
        query.shouldTestNextSiblings = shouldTestNextSiblings;
        return query;
    }
    function compileRules(rules, options, context) {
        var _a;
        return rules.reduce((previous, rule) => previous === boolbase.falseFunc
            ? boolbase.falseFunc
            : compileGeneralSelector(previous, rule, options, context, compileToken), (_a = options.rootFunc) !== null && _a !== void 0 ? _a : boolbase.trueFunc);
    }
    function reduceRules(a, b) {
        if (b === boolbase.falseFunc || a === boolbase.trueFunc) {
            return a;
        }
        if (a === boolbase.falseFunc || b === boolbase.trueFunc) {
            return b;
        }
        return function combine(elem) {
            return a(elem) || b(elem);
        };
    }

    const defaultEquals = (a, b) => a === b;
    const defaultOptions = {
        adapter: DomUtils,
        equals: defaultEquals,
    };
    function convertOptionFormats(options) {
        var _a, _b, _c, _d;
        /*
         * We force one format of options to the other one.
         */
        // @ts-expect-error Default options may have incompatible `Node` / `ElementNode`.
        const opts = options !== null && options !== void 0 ? options : defaultOptions;
        // @ts-expect-error Same as above.
        (_a = opts.adapter) !== null && _a !== void 0 ? _a : (opts.adapter = DomUtils);
        // @ts-expect-error `equals` does not exist on `Options`
        (_b = opts.equals) !== null && _b !== void 0 ? _b : (opts.equals = (_d = (_c = opts.adapter) === null || _c === void 0 ? void 0 : _c.equals) !== null && _d !== void 0 ? _d : defaultEquals);
        return opts;
    }
    function wrapCompile(func) {
        return function addAdapter(selector, options, context) {
            const opts = convertOptionFormats(options);
            return func(selector, opts, context);
        };
    }
    const _compileToken = wrapCompile(compileToken);
    function prepareContext(elems, adapter, shouldTestNextSiblings = false) {
        /*
         * Add siblings if the query requires them.
         * See https://github.com/fb55/css-select/pull/43#issuecomment-225414692
         */
        if (shouldTestNextSiblings) {
            elems = appendNextSiblings(elems, adapter);
        }
        return Array.isArray(elems)
            ? adapter.removeSubsets(elems)
            : adapter.getChildren(elems);
    }
    function appendNextSiblings(elem, adapter) {
        // Order matters because jQuery seems to check the children before the siblings
        const elems = Array.isArray(elem) ? elem.slice(0) : [elem];
        const elemsLength = elems.length;
        for (let i = 0; i < elemsLength; i++) {
            const nextSiblings = getNextSiblings(elems[i], adapter);
            elems.push(...nextSiblings);
        }
        return elems;
    }

    const filterNames = new Set([
        "first",
        "last",
        "eq",
        "gt",
        "nth",
        "lt",
        "even",
        "odd",
    ]);
    function isFilter(s) {
        if (s.type !== "pseudo")
            return false;
        if (filterNames.has(s.name))
            return true;
        if (s.name === "not" && Array.isArray(s.data)) {
            // Only consider `:not` with embedded filters
            return s.data.some((s) => s.some(isFilter));
        }
        return false;
    }
    function getLimit(filter, data, partLimit) {
        const num = data != null ? parseInt(data, 10) : NaN;
        switch (filter) {
            case "first":
                return 1;
            case "nth":
            case "eq":
                return isFinite(num) ? (num >= 0 ? num + 1 : Infinity) : 0;
            case "lt":
                return isFinite(num)
                    ? num >= 0
                        ? Math.min(num, partLimit)
                        : Infinity
                    : 0;
            case "gt":
                return isFinite(num) ? Infinity : 0;
            case "odd":
                return 2 * partLimit;
            case "even":
                return 2 * partLimit - 1;
            case "last":
            case "not":
                return Infinity;
        }
    }

    function getDocumentRoot(node) {
        while (node.parent)
            node = node.parent;
        return node;
    }
    function groupSelectors(selectors) {
        const filteredSelectors = [];
        const plainSelectors = [];
        for (const selector of selectors) {
            if (selector.some(isFilter)) {
                filteredSelectors.push(selector);
            }
            else {
                plainSelectors.push(selector);
            }
        }
        return [plainSelectors, filteredSelectors];
    }

    const UNIVERSAL_SELECTOR = {
        type: SelectorType.Universal,
        namespace: null,
    };
    const SCOPE_PSEUDO = {
        type: SelectorType.Pseudo,
        name: "scope",
        data: null,
    };
    function is$1(element, selector, options = {}) {
        return some([element], selector, options);
    }
    function some(elements, selector, options = {}) {
        if (typeof selector === "function")
            return elements.some(selector);
        const [plain, filtered] = groupSelectors(parse$4(selector));
        return ((plain.length > 0 && elements.some(_compileToken(plain, options))) ||
            filtered.some((sel) => filterBySelector(sel, elements, options).length > 0));
    }
    function filterByPosition(filter, elems, data, options) {
        const num = typeof data === "string" ? parseInt(data, 10) : NaN;
        switch (filter) {
            case "first":
            case "lt":
                // Already done in `getLimit`
                return elems;
            case "last":
                return elems.length > 0 ? [elems[elems.length - 1]] : elems;
            case "nth":
            case "eq":
                return isFinite(num) && Math.abs(num) < elems.length
                    ? [num < 0 ? elems[elems.length + num] : elems[num]]
                    : [];
            case "gt":
                return isFinite(num) ? elems.slice(num + 1) : [];
            case "even":
                return elems.filter((_, i) => i % 2 === 0);
            case "odd":
                return elems.filter((_, i) => i % 2 === 1);
            case "not": {
                const filtered = new Set(filterParsed(data, elems, options));
                return elems.filter((e) => !filtered.has(e));
            }
        }
    }
    function filter$1(selector, elements, options = {}) {
        return filterParsed(parse$4(selector), elements, options);
    }
    /**
     * Filter a set of elements by a selector.
     *
     * Will return elements in the original order.
     *
     * @param selector Selector to filter by.
     * @param elements Elements to filter.
     * @param options Options for selector.
     */
    function filterParsed(selector, elements, options) {
        if (elements.length === 0)
            return [];
        const [plainSelectors, filteredSelectors] = groupSelectors(selector);
        let found;
        if (plainSelectors.length) {
            const filtered = filterElements(elements, plainSelectors, options);
            // If there are no filters, just return
            if (filteredSelectors.length === 0) {
                return filtered;
            }
            // Otherwise, we have to do some filtering
            if (filtered.length) {
                found = new Set(filtered);
            }
        }
        for (let i = 0; i < filteredSelectors.length && (found === null || found === void 0 ? void 0 : found.size) !== elements.length; i++) {
            const filteredSelector = filteredSelectors[i];
            const missing = found
                ? elements.filter((e) => isTag(e) && !found.has(e))
                : elements;
            if (missing.length === 0)
                break;
            const filtered = filterBySelector(filteredSelector, elements, options);
            if (filtered.length) {
                if (!found) {
                    /*
                     * If we haven't found anything before the last selector,
                     * just return what we found now.
                     */
                    if (i === filteredSelectors.length - 1) {
                        return filtered;
                    }
                    found = new Set(filtered);
                }
                else {
                    filtered.forEach((el) => found.add(el));
                }
            }
        }
        return typeof found !== "undefined"
            ? (found.size === elements.length
                ? elements
                : // Filter elements to preserve order
                    elements.filter((el) => found.has(el)))
            : [];
    }
    function filterBySelector(selector, elements, options) {
        var _a;
        if (selector.some(isTraversal$1)) {
            /*
             * Get root node, run selector with the scope
             * set to all of our nodes.
             */
            const root = (_a = options.root) !== null && _a !== void 0 ? _a : getDocumentRoot(elements[0]);
            const opts = { ...options, context: elements, relativeSelector: false };
            selector.push(SCOPE_PSEUDO);
            return findFilterElements(root, selector, opts, true, elements.length);
        }
        // Performance optimization: If we don't have to traverse, just filter set.
        return findFilterElements(elements, selector, options, false, elements.length);
    }
    function select(selector, root, options = {}, limit = Infinity) {
        if (typeof selector === "function") {
            return find$1(root, selector);
        }
        const [plain, filtered] = groupSelectors(parse$4(selector));
        const results = filtered.map((sel) => findFilterElements(root, sel, options, true, limit));
        // Plain selectors can be queried in a single go
        if (plain.length) {
            results.push(findElements(root, plain, options, limit));
        }
        if (results.length === 0) {
            return [];
        }
        // If there was only a single selector, just return the result
        if (results.length === 1) {
            return results[0];
        }
        // Sort results, filtering for duplicates
        return uniqueSort(results.reduce((a, b) => [...a, ...b]));
    }
    /**
     *
     * @param root Element(s) to search from.
     * @param selector Selector to look for.
     * @param options Options for querying.
     * @param queryForSelector Query multiple levels deep for the initial selector, even if it doesn't contain a traversal.
     */
    function findFilterElements(root, selector, options, queryForSelector, totalLimit) {
        const filterIndex = selector.findIndex(isFilter);
        const sub = selector.slice(0, filterIndex);
        const filter = selector[filterIndex];
        // If we are at the end of the selector, we can limit the number of elements to retrieve.
        const partLimit = selector.length - 1 === filterIndex ? totalLimit : Infinity;
        /*
         * Set the number of elements to retrieve.
         * Eg. for :first, we only have to get a single element.
         */
        const limit = getLimit(filter.name, filter.data, partLimit);
        if (limit === 0)
            return [];
        /*
         * Skip `findElements` call if our selector starts with a positional
         * pseudo.
         */
        const elemsNoLimit = sub.length === 0 && !Array.isArray(root)
            ? getChildren(root).filter(isTag)
            : sub.length === 0
                ? (Array.isArray(root) ? root : [root]).filter(isTag)
                : queryForSelector || sub.some(isTraversal$1)
                    ? findElements(root, [sub], options, limit)
                    : filterElements(root, [sub], options);
        const elems = elemsNoLimit.slice(0, limit);
        let result = filterByPosition(filter.name, elems, filter.data, options);
        if (result.length === 0 || selector.length === filterIndex + 1) {
            return result;
        }
        const remainingSelector = selector.slice(filterIndex + 1);
        const remainingHasTraversal = remainingSelector.some(isTraversal$1);
        if (remainingHasTraversal) {
            if (isTraversal$1(remainingSelector[0])) {
                const { type } = remainingSelector[0];
                if (type === SelectorType.Sibling ||
                    type === SelectorType.Adjacent) {
                    // If we have a sibling traversal, we need to also look at the siblings.
                    result = prepareContext(result, DomUtils, true);
                }
                // Avoid a traversal-first selector error.
                remainingSelector.unshift(UNIVERSAL_SELECTOR);
            }
            options = {
                ...options,
                // Avoid absolutizing the selector
                relativeSelector: false,
                /*
                 * Add a custom root func, to make sure traversals don't match elements
                 * that aren't a part of the considered tree.
                 */
                rootFunc: (el) => result.includes(el),
            };
        }
        else if (options.rootFunc && options.rootFunc !== boolbase.trueFunc) {
            options = { ...options, rootFunc: boolbase.trueFunc };
        }
        /*
         * If we have another filter, recursively call `findFilterElements`,
         * with the `recursive` flag disabled. We only have to look for more
         * elements when we see a traversal.
         *
         * Otherwise,
         */
        return remainingSelector.some(isFilter)
            ? findFilterElements(result, remainingSelector, options, false, totalLimit)
            : remainingHasTraversal
                ? // Query existing elements to resolve traversal.
                    findElements(result, [remainingSelector], options, totalLimit)
                : // If we don't have any more traversals, simply filter elements.
                    filterElements(result, [remainingSelector], options);
    }
    function findElements(root, sel, options, limit) {
        const query = _compileToken(sel, options, root);
        return find$1(root, query, limit);
    }
    function find$1(root, query, limit = Infinity) {
        const elems = prepareContext(root, DomUtils, query.shouldTestNextSiblings);
        return find$2((node) => isTag(node) && query(node), elems, true, limit);
    }
    function filterElements(elements, sel, options) {
        const els = (Array.isArray(elements) ? elements : [elements]).filter(isTag);
        if (els.length === 0)
            return els;
        const query = _compileToken(sel, options);
        return query === boolbase.trueFunc ? els : els.filter(query);
    }

    /**
     * Methods for traversing the DOM structure.
     *
     * @module cheerio/traversing
     */
    const reSiblingSelector = /^\s*[~+]/;
    /**
     * Get the descendants of each element in the current set of matched elements,
     * filtered by a selector, jQuery object, or element.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('#fruits').find('li').length;
     * //=> 3
     * $('#fruits').find($('.apple')).length;
     * //=> 1
     * ```
     *
     * @param selectorOrHaystack - Element to look for.
     * @returns The found elements.
     * @see {@link https://api.jquery.com/find/}
     */
    function find(selectorOrHaystack) {
        var _a;
        if (!selectorOrHaystack) {
            return this._make([]);
        }
        const context = this.toArray();
        if (typeof selectorOrHaystack !== 'string') {
            const haystack = isCheerio(selectorOrHaystack)
                ? selectorOrHaystack.toArray()
                : [selectorOrHaystack];
            return this._make(haystack.filter((elem) => context.some((node) => contains(node, elem))));
        }
        const elems = reSiblingSelector.test(selectorOrHaystack)
            ? context
            : this.children().toArray();
        const options = {
            context,
            root: (_a = this._root) === null || _a === void 0 ? void 0 : _a[0],
            // Pass options that are recognized by `cheerio-select`
            xmlMode: this.options.xmlMode,
            lowerCaseTags: this.options.lowerCaseTags,
            lowerCaseAttributeNames: this.options.lowerCaseAttributeNames,
            pseudos: this.options.pseudos,
            quirksMode: this.options.quirksMode,
        };
        return this._make(select(selectorOrHaystack, elems, options));
    }
    /**
     * Creates a matcher, using a particular mapping function. Matchers provide a
     * function that finds elements using a generating function, supporting filtering.
     *
     * @private
     * @param matchMap - Mapping function.
     * @returns - Function for wrapping generating functions.
     */
    function _getMatcher(matchMap) {
        return function (fn, ...postFns) {
            return function (selector) {
                var _a;
                let matched = matchMap(fn, this);
                if (selector) {
                    matched = filterArray(matched, selector, this.options.xmlMode, (_a = this._root) === null || _a === void 0 ? void 0 : _a[0]);
                }
                return this._make(
                // Post processing is only necessary if there is more than one element.
                this.length > 1 && matched.length > 1
                    ? postFns.reduce((elems, fn) => fn(elems), matched)
                    : matched);
            };
        };
    }
    /** Matcher that adds multiple elements for each entry in the input. */
    const _matcher = _getMatcher((fn, elems) => {
        const ret = [];
        for (let i = 0; i < elems.length; i++) {
            const value = fn(elems[i]);
            ret.push(value);
        }
        return new Array().concat(...ret);
    });
    /** Matcher that adds at most one element for each entry in the input. */
    const _singleMatcher = _getMatcher((fn, elems) => {
        const ret = [];
        for (let i = 0; i < elems.length; i++) {
            const value = fn(elems[i]);
            if (value !== null) {
                ret.push(value);
            }
        }
        return ret;
    });
    /**
     * Matcher that supports traversing until a condition is met.
     *
     * @returns A function usable for `*Until` methods.
     */
    function _matchUntil(nextElem, ...postFns) {
        // We use a variable here that is used from within the matcher.
        let matches = null;
        const innerMatcher = _getMatcher((nextElem, elems) => {
            const matched = [];
            domEach(elems, (elem) => {
                for (let next; (next = nextElem(elem)); elem = next) {
                    // FIXME: `matched` might contain duplicates here and the index is too large.
                    if (matches === null || matches === void 0 ? void 0 : matches(next, matched.length))
                        break;
                    matched.push(next);
                }
            });
            return matched;
        })(nextElem, ...postFns);
        return function (selector, filterSelector) {
            // Override `matches` variable with the new target.
            matches =
                typeof selector === 'string'
                    ? (elem) => is$1(elem, selector, this.options)
                    : selector
                        ? getFilterFn(selector)
                        : null;
            const ret = innerMatcher.call(this, filterSelector);
            // Set `matches` to `null`, so we don't waste memory.
            matches = null;
            return ret;
        };
    }
    function _removeDuplicates(elems) {
        return Array.from(new Set(elems));
    }
    /**
     * Get the parent of each element in the current set of matched elements,
     * optionally filtered by a selector.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.pear').parent().attr('id');
     * //=> fruits
     * ```
     *
     * @param selector - If specified filter for parent.
     * @returns The parents.
     * @see {@link https://api.jquery.com/parent/}
     */
    const parent = _singleMatcher(({ parent }) => (parent && !isDocument(parent) ? parent : null), _removeDuplicates);
    /**
     * Get a set of parents filtered by `selector` of each element in the current
     * set of match elements.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.orange').parents().length;
     * //=> 2
     * $('.orange').parents('#fruits').length;
     * //=> 1
     * ```
     *
     * @param selector - If specified filter for parents.
     * @returns The parents.
     * @see {@link https://api.jquery.com/parents/}
     */
    const parents = _matcher((elem) => {
        const matched = [];
        while (elem.parent && !isDocument(elem.parent)) {
            matched.push(elem.parent);
            elem = elem.parent;
        }
        return matched;
    }, uniqueSort, (elems) => elems.reverse());
    /**
     * Get the ancestors of each element in the current set of matched elements, up
     * to but not including the element matched by the selector, DOM node, or cheerio object.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.orange').parentsUntil('#food').length;
     * //=> 1
     * ```
     *
     * @param selector - Selector for element to stop at.
     * @param filterSelector - Optional filter for parents.
     * @returns The parents.
     * @see {@link https://api.jquery.com/parentsUntil/}
     */
    const parentsUntil = _matchUntil(({ parent }) => (parent && !isDocument(parent) ? parent : null), uniqueSort, (elems) => elems.reverse());
    /**
     * For each element in the set, get the first element that matches the selector
     * by testing the element itself and traversing up through its ancestors in the DOM tree.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.orange').closest();
     * //=> []
     *
     * $('.orange').closest('.apple');
     * // => []
     *
     * $('.orange').closest('li');
     * //=> [<li class="orange">Orange</li>]
     *
     * $('.orange').closest('#fruits');
     * //=> [<ul id="fruits"> ... </ul>]
     * ```
     *
     * @param selector - Selector for the element to find.
     * @returns The closest nodes.
     * @see {@link https://api.jquery.com/closest/}
     */
    function closest(selector) {
        var _a;
        const set = [];
        if (!selector) {
            return this._make(set);
        }
        const selectOpts = {
            xmlMode: this.options.xmlMode,
            root: (_a = this._root) === null || _a === void 0 ? void 0 : _a[0],
        };
        const selectFn = typeof selector === 'string'
            ? (elem) => is$1(elem, selector, selectOpts)
            : getFilterFn(selector);
        domEach(this, (elem) => {
            while (elem && isTag(elem)) {
                if (selectFn(elem, 0)) {
                    // Do not add duplicate elements to the set
                    if (!set.includes(elem)) {
                        set.push(elem);
                    }
                    break;
                }
                elem = elem.parent;
            }
        });
        return this._make(set);
    }
    /**
     * Gets the next sibling of the first selected element, optionally filtered by a selector.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.apple').next().hasClass('orange');
     * //=> true
     * ```
     *
     * @param selector - If specified filter for sibling.
     * @returns The next nodes.
     * @see {@link https://api.jquery.com/next/}
     */
    const next = _singleMatcher((elem) => nextElementSibling(elem));
    /**
     * Gets all the following siblings of the first selected element, optionally
     * filtered by a selector.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.apple').nextAll();
     * //=> [<li class="orange">Orange</li>, <li class="pear">Pear</li>]
     * $('.apple').nextAll('.orange');
     * //=> [<li class="orange">Orange</li>]
     * ```
     *
     * @param selector - If specified filter for siblings.
     * @returns The next nodes.
     * @see {@link https://api.jquery.com/nextAll/}
     */
    const nextAll = _matcher((elem) => {
        const matched = [];
        while (elem.next) {
            elem = elem.next;
            if (isTag(elem))
                matched.push(elem);
        }
        return matched;
    }, _removeDuplicates);
    /**
     * Gets all the following siblings up to but not including the element matched
     * by the selector, optionally filtered by another selector.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.apple').nextUntil('.pear');
     * //=> [<li class="orange">Orange</li>]
     * ```
     *
     * @param selector - Selector for element to stop at.
     * @param filterSelector - If specified filter for siblings.
     * @returns The next nodes.
     * @see {@link https://api.jquery.com/nextUntil/}
     */
    const nextUntil = _matchUntil((el) => nextElementSibling(el), _removeDuplicates);
    /**
     * Gets the previous sibling of the first selected element optionally filtered
     * by a selector.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.orange').prev().hasClass('apple');
     * //=> true
     * ```
     *
     * @param selector - If specified filter for siblings.
     * @returns The previous nodes.
     * @see {@link https://api.jquery.com/prev/}
     */
    const prev = _singleMatcher((elem) => prevElementSibling(elem));
    /**
     * Gets all the preceding siblings of the first selected element, optionally
     * filtered by a selector.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.pear').prevAll();
     * //=> [<li class="orange">Orange</li>, <li class="apple">Apple</li>]
     *
     * $('.pear').prevAll('.orange');
     * //=> [<li class="orange">Orange</li>]
     * ```
     *
     * @param selector - If specified filter for siblings.
     * @returns The previous nodes.
     * @see {@link https://api.jquery.com/prevAll/}
     */
    const prevAll = _matcher((elem) => {
        const matched = [];
        while (elem.prev) {
            elem = elem.prev;
            if (isTag(elem))
                matched.push(elem);
        }
        return matched;
    }, _removeDuplicates);
    /**
     * Gets all the preceding siblings up to but not including the element matched
     * by the selector, optionally filtered by another selector.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.pear').prevUntil('.apple');
     * //=> [<li class="orange">Orange</li>]
     * ```
     *
     * @param selector - Selector for element to stop at.
     * @param filterSelector - If specified filter for siblings.
     * @returns The previous nodes.
     * @see {@link https://api.jquery.com/prevUntil/}
     */
    const prevUntil = _matchUntil((el) => prevElementSibling(el), _removeDuplicates);
    /**
     * Get the siblings of each element (excluding the element) in the set of
     * matched elements, optionally filtered by a selector.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.pear').siblings().length;
     * //=> 2
     *
     * $('.pear').siblings('.orange').length;
     * //=> 1
     * ```
     *
     * @param selector - If specified filter for siblings.
     * @returns The siblings.
     * @see {@link https://api.jquery.com/siblings/}
     */
    const siblings = _matcher((elem) => getSiblings(elem).filter((el) => isTag(el) && el !== elem), uniqueSort);
    /**
     * Gets the element children of each element in the set of matched elements.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('#fruits').children().length;
     * //=> 3
     *
     * $('#fruits').children('.pear').text();
     * //=> Pear
     * ```
     *
     * @param selector - If specified filter for children.
     * @returns The children.
     * @see {@link https://api.jquery.com/children/}
     */
    const children = _matcher((elem) => getChildren(elem).filter(isTag), _removeDuplicates);
    /**
     * Gets the children of each element in the set of matched elements, including
     * text and comment nodes.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('#fruits').contents().length;
     * //=> 3
     * ```
     *
     * @returns The children.
     * @see {@link https://api.jquery.com/contents/}
     */
    function contents() {
        const elems = this.toArray().reduce((newElems, elem) => hasChildren(elem) ? newElems.concat(elem.children) : newElems, []);
        return this._make(elems);
    }
    /**
     * Iterates over a cheerio object, executing a function for each matched
     * element. When the callback is fired, the function is fired in the context of
     * the DOM element, so `this` refers to the current element, which is equivalent
     * to the function parameter `element`. To break out of the `each` loop early,
     * return with `false`.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * const fruits = [];
     *
     * $('li').each(function (i, elem) {
     *   fruits[i] = $(this).text();
     * });
     *
     * fruits.join(', ');
     * //=> Apple, Orange, Pear
     * ```
     *
     * @param fn - Function to execute.
     * @returns The instance itself, useful for chaining.
     * @see {@link https://api.jquery.com/each/}
     */
    function each(fn) {
        let i = 0;
        const len = this.length;
        while (i < len && fn.call(this[i], i, this[i]) !== false)
            ++i;
        return this;
    }
    /**
     * Pass each element in the current matched set through a function, producing a
     * new Cheerio object containing the return values. The function can return an
     * individual data item or an array of data items to be inserted into the
     * resulting set. If an array is returned, the elements inside the array are
     * inserted into the set. If the function returns null or undefined, no element
     * will be inserted.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('li')
     *   .map(function (i, el) {
     *     // this === el
     *     return $(this).text();
     *   })
     *   .toArray()
     *   .join(' ');
     * //=> "apple orange pear"
     * ```
     *
     * @param fn - Function to execute.
     * @returns The mapped elements, wrapped in a Cheerio collection.
     * @see {@link https://api.jquery.com/map/}
     */
    function map(fn) {
        let elems = [];
        for (let i = 0; i < this.length; i++) {
            const el = this[i];
            const val = fn.call(el, i, el);
            if (val != null) {
                elems = elems.concat(val);
            }
        }
        return this._make(elems);
    }
    /**
     * Creates a function to test if a filter is matched.
     *
     * @param match - A filter.
     * @returns A function that determines if a filter has been matched.
     */
    function getFilterFn(match) {
        if (typeof match === 'function') {
            return (el, i) => match.call(el, i, el);
        }
        if (isCheerio(match)) {
            return (el) => Array.prototype.includes.call(match, el);
        }
        return function (el) {
            return match === el;
        };
    }
    function filter(match) {
        var _a;
        return this._make(filterArray(this.toArray(), match, this.options.xmlMode, (_a = this._root) === null || _a === void 0 ? void 0 : _a[0]));
    }
    function filterArray(nodes, match, xmlMode, root) {
        return typeof match === 'string'
            ? filter$1(match, nodes, { xmlMode, root })
            : nodes.filter(getFilterFn(match));
    }
    /**
     * Checks the current list of elements and returns `true` if _any_ of the
     * elements match the selector. If using an element or Cheerio selection,
     * returns `true` if _any_ of the elements match. If using a predicate function,
     * the function is executed in the context of the selected element, so `this`
     * refers to the current element.
     *
     * @category Attributes
     * @param selector - Selector for the selection.
     * @returns Whether or not the selector matches an element of the instance.
     * @see {@link https://api.jquery.com/is/}
     */
    function is(selector) {
        const nodes = this.toArray();
        return typeof selector === 'string'
            ? some(nodes.filter(isTag), selector, this.options)
            : selector
                ? nodes.some(getFilterFn(selector))
                : false;
    }
    /**
     * Remove elements from the set of matched elements. Given a Cheerio object that
     * represents a set of DOM elements, the `.not()` method constructs a new
     * Cheerio object from a subset of the matching elements. The supplied selector
     * is tested against each element; the elements that don't match the selector
     * will be included in the result.
     *
     * The `.not()` method can take a function as its argument in the same way that
     * `.filter()` does. Elements for which the function returns `true` are excluded
     * from the filtered set; all other elements are included.
     *
     * @category Traversing
     * @example <caption>Selector</caption>
     *
     * ```js
     * $('li').not('.apple').length;
     * //=> 2
     * ```
     *
     * @example <caption>Function</caption>
     *
     * ```js
     * $('li').not(function (i, el) {
     *   // this === el
     *   return $(this).attr('class') === 'orange';
     * }).length; //=> 2
     * ```
     *
     * @param match - Value to look for, following the rules above.
     * @param container - Optional node to filter instead.
     * @returns The filtered collection.
     * @see {@link https://api.jquery.com/not/}
     */
    function not(match) {
        let nodes = this.toArray();
        if (typeof match === 'string') {
            const matches = new Set(filter$1(match, nodes, this.options));
            nodes = nodes.filter((el) => !matches.has(el));
        }
        else {
            const filterFn = getFilterFn(match);
            nodes = nodes.filter((el, i) => !filterFn(el, i));
        }
        return this._make(nodes);
    }
    /**
     * Filters the set of matched elements to only those which have the given DOM
     * element as a descendant or which have a descendant that matches the given
     * selector. Equivalent to `.filter(':has(selector)')`.
     *
     * @category Traversing
     * @example <caption>Selector</caption>
     *
     * ```js
     * $('ul').has('.pear').attr('id');
     * //=> fruits
     * ```
     *
     * @example <caption>Element</caption>
     *
     * ```js
     * $('ul').has($('.pear')[0]).attr('id');
     * //=> fruits
     * ```
     *
     * @param selectorOrHaystack - Element to look for.
     * @returns The filtered collection.
     * @see {@link https://api.jquery.com/has/}
     */
    function has(selectorOrHaystack) {
        return this.filter(typeof selectorOrHaystack === 'string'
            ? // Using the `:has` selector here short-circuits searches.
                `:has(${selectorOrHaystack})`
            : (_, el) => this._make(el).find(selectorOrHaystack).length > 0);
    }
    /**
     * Will select the first element of a cheerio object.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('#fruits').children().first().text();
     * //=> Apple
     * ```
     *
     * @returns The first element.
     * @see {@link https://api.jquery.com/first/}
     */
    function first() {
        return this.length > 1 ? this._make(this[0]) : this;
    }
    /**
     * Will select the last element of a cheerio object.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('#fruits').children().last().text();
     * //=> Pear
     * ```
     *
     * @returns The last element.
     * @see {@link https://api.jquery.com/last/}
     */
    function last() {
        return this.length > 0 ? this._make(this[this.length - 1]) : this;
    }
    /**
     * Reduce the set of matched elements to the one at the specified index. Use
     * `.eq(-i)` to count backwards from the last selected element.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('li').eq(0).text();
     * //=> Apple
     *
     * $('li').eq(-1).text();
     * //=> Pear
     * ```
     *
     * @param i - Index of the element to select.
     * @returns The element at the `i`th position.
     * @see {@link https://api.jquery.com/eq/}
     */
    function eq(i) {
        var _a;
        i = +i;
        // Use the first identity optimization if possible
        if (i === 0 && this.length <= 1)
            return this;
        if (i < 0)
            i = this.length + i;
        return this._make((_a = this[i]) !== null && _a !== void 0 ? _a : []);
    }
    function get(i) {
        if (i == null) {
            return this.toArray();
        }
        return this[i < 0 ? this.length + i : i];
    }
    /**
     * Retrieve all the DOM elements contained in the jQuery set as an array.
     *
     * @example
     *
     * ```js
     * $('li').toArray();
     * //=> [ {...}, {...}, {...} ]
     * ```
     *
     * @returns The contained items.
     */
    function toArray() {
        return Array.prototype.slice.call(this);
    }
    /**
     * Search for a given element from among the matched elements.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.pear').index();
     * //=> 2 $('.orange').index('li');
     * //=> 1
     * $('.apple').index($('#fruit, li'));
     * //=> 1
     * ```
     *
     * @param selectorOrNeedle - Element to look for.
     * @returns The index of the element.
     * @see {@link https://api.jquery.com/index/}
     */
    function index(selectorOrNeedle) {
        let $haystack;
        let needle;
        if (selectorOrNeedle == null) {
            $haystack = this.parent().children();
            needle = this[0];
        }
        else if (typeof selectorOrNeedle === 'string') {
            $haystack = this._make(selectorOrNeedle);
            needle = this[0];
        }
        else {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            $haystack = this;
            needle = isCheerio(selectorOrNeedle)
                ? selectorOrNeedle[0]
                : selectorOrNeedle;
        }
        return Array.prototype.indexOf.call($haystack, needle);
    }
    /**
     * Gets the elements matching the specified range (0-based position).
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('li').slice(1).eq(0).text();
     * //=> 'Orange'
     *
     * $('li').slice(1, 2).length;
     * //=> 1
     * ```
     *
     * @param start - A position at which the elements begin to be selected. If
     *   negative, it indicates an offset from the end of the set.
     * @param end - A position at which the elements stop being selected. If
     *   negative, it indicates an offset from the end of the set. If omitted, the
     *   range continues until the end of the set.
     * @returns The elements matching the specified range.
     * @see {@link https://api.jquery.com/slice/}
     */
    function slice(start, end) {
        return this._make(Array.prototype.slice.call(this, start, end));
    }
    /**
     * End the most recent filtering operation in the current chain and return the
     * set of matched elements to its previous state.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('li').eq(0).end().length;
     * //=> 3
     * ```
     *
     * @returns The previous state of the set of matched elements.
     * @see {@link https://api.jquery.com/end/}
     */
    function end() {
        var _a;
        return (_a = this.prevObject) !== null && _a !== void 0 ? _a : this._make([]);
    }
    /**
     * Add elements to the set of matched elements.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('.apple').add('.orange').length;
     * //=> 2
     * ```
     *
     * @param other - Elements to add.
     * @param context - Optionally the context of the new selection.
     * @returns The combined set.
     * @see {@link https://api.jquery.com/add/}
     */
    function add(other, context) {
        const selection = this._make(other, context);
        const contents = uniqueSort([...this.get(), ...selection.get()]);
        return this._make(contents);
    }
    /**
     * Add the previous set of elements on the stack to the current set, optionally
     * filtered by a selector.
     *
     * @category Traversing
     * @example
     *
     * ```js
     * $('li').eq(0).addBack('.orange').length;
     * //=> 2
     * ```
     *
     * @param selector - Selector for the elements to add.
     * @returns The combined set.
     * @see {@link https://api.jquery.com/addBack/}
     */
    function addBack(selector) {
        return this.prevObject
            ? this.add(selector ? this.prevObject.filter(selector) : this.prevObject)
            : this;
    }

    var Traversing = /*#__PURE__*/Object.freeze({
        __proto__: null,
        find: find,
        parent: parent,
        parents: parents,
        parentsUntil: parentsUntil,
        closest: closest,
        next: next,
        nextAll: nextAll,
        nextUntil: nextUntil,
        prev: prev,
        prevAll: prevAll,
        prevUntil: prevUntil,
        siblings: siblings,
        children: children,
        contents: contents,
        each: each,
        map: map,
        filter: filter,
        filterArray: filterArray,
        is: is,
        not: not,
        has: has,
        first: first,
        last: last,
        eq: eq,
        get: get,
        toArray: toArray,
        index: index,
        slice: slice,
        end: end,
        add: add,
        addBack: addBack
    });

    /**
     * Get the parse function with options.
     *
     * @param parser - The parser function.
     * @returns The parse function with options.
     */
    function getParse(parser) {
        /**
         * Parse a HTML string or a node.
         *
         * @param content - The HTML string or node.
         * @param options - The parser options.
         * @param isDocument - If `content` is a document.
         * @param context - The context node in the DOM tree.
         * @returns The parsed document node.
         */
        return function parse(content, options, isDocument$1, context) {
            if (typeof Buffer !== 'undefined' && Buffer.isBuffer(content)) {
                content = content.toString();
            }
            if (typeof content === 'string') {
                return parser(content, options, isDocument$1, context);
            }
            const doc = content;
            if (!Array.isArray(doc) && isDocument(doc)) {
                // If `doc` is already a root, just return it
                return doc;
            }
            // Add conent to new root element
            const root = new Document([]);
            // Update the DOM using the root
            update(doc, root);
            return root;
        };
    }
    /**
     * Update the dom structure, for one changed layer.
     *
     * @param newChilds - The new children.
     * @param parent - The new parent.
     * @returns The parent node.
     */
    function update(newChilds, parent) {
        // Normalize
        const arr = Array.isArray(newChilds) ? newChilds : [newChilds];
        // Update parent
        if (parent) {
            parent.children = arr;
        }
        else {
            parent = null;
        }
        // Update neighbors
        for (let i = 0; i < arr.length; i++) {
            const node = arr[i];
            // Cleanly remove existing nodes from their previous structures.
            if (node.parent && node.parent.children !== arr) {
                removeElement(node);
            }
            if (parent) {
                node.prev = arr[i - 1] || null;
                node.next = arr[i + 1] || null;
            }
            else {
                node.prev = node.next = null;
            }
            node.parent = parent;
        }
        return parent;
    }

    /**
     * Methods for modifying the DOM structure.
     *
     * @module cheerio/manipulation
     */
    /**
     * Create an array of nodes, recursing into arrays and parsing strings if necessary.
     *
     * @private
     * @category Manipulation
     * @param elem - Elements to make an array of.
     * @param clone - Optionally clone nodes.
     * @returns The array of nodes.
     */
    function _makeDomArray(elem, clone) {
        if (elem == null) {
            return [];
        }
        if (isCheerio(elem)) {
            return clone ? cloneDom(elem.get()) : elem.get();
        }
        if (Array.isArray(elem)) {
            return elem.reduce((newElems, el) => newElems.concat(this._makeDomArray(el, clone)), []);
        }
        if (typeof elem === 'string') {
            return this._parse(elem, this.options, false, null).children;
        }
        return clone ? cloneDom([elem]) : [elem];
    }
    function _insert(concatenator) {
        return function (...elems) {
            const lastIdx = this.length - 1;
            return domEach(this, (el, i) => {
                if (!hasChildren(el))
                    return;
                const domSrc = typeof elems[0] === 'function'
                    ? elems[0].call(el, i, this._render(el.children))
                    : elems;
                const dom = this._makeDomArray(domSrc, i < lastIdx);
                concatenator(dom, el.children, el);
            });
        };
    }
    /**
     * Modify an array in-place, removing some number of elements and adding new
     * elements directly following them.
     *
     * @private
     * @category Manipulation
     * @param array - Target array to splice.
     * @param spliceIdx - Index at which to begin changing the array.
     * @param spliceCount - Number of elements to remove from the array.
     * @param newElems - Elements to insert into the array.
     * @param parent - The parent of the node.
     * @returns The spliced array.
     */
    function uniqueSplice(array, spliceIdx, spliceCount, newElems, parent) {
        var _a, _b;
        const spliceArgs = [
            spliceIdx,
            spliceCount,
            ...newElems,
        ];
        const prev = spliceIdx === 0 ? null : array[spliceIdx - 1];
        const next = spliceIdx + spliceCount >= array.length
            ? null
            : array[spliceIdx + spliceCount];
        /*
         * Before splicing in new elements, ensure they do not already appear in the
         * current array.
         */
        for (let idx = 0; idx < newElems.length; ++idx) {
            const node = newElems[idx];
            const oldParent = node.parent;
            if (oldParent) {
                const oldSiblings = oldParent.children;
                const prevIdx = oldSiblings.indexOf(node);
                if (prevIdx > -1) {
                    oldParent.children.splice(prevIdx, 1);
                    if (parent === oldParent && spliceIdx > prevIdx) {
                        spliceArgs[0]--;
                    }
                }
            }
            node.parent = parent;
            if (node.prev) {
                node.prev.next = (_a = node.next) !== null && _a !== void 0 ? _a : null;
            }
            if (node.next) {
                node.next.prev = (_b = node.prev) !== null && _b !== void 0 ? _b : null;
            }
            node.prev = idx === 0 ? prev : newElems[idx - 1];
            node.next = idx === newElems.length - 1 ? next : newElems[idx + 1];
        }
        if (prev) {
            prev.next = newElems[0];
        }
        if (next) {
            next.prev = newElems[newElems.length - 1];
        }
        return array.splice(...spliceArgs);
    }
    /**
     * Insert every element in the set of matched elements to the end of the target.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * $('<li class="plum">Plum</li>').appendTo('#fruits');
     * $.html();
     * //=>  <ul id="fruits">
     * //      <li class="apple">Apple</li>
     * //      <li class="orange">Orange</li>
     * //      <li class="pear">Pear</li>
     * //      <li class="plum">Plum</li>
     * //    </ul>
     * ```
     *
     * @param target - Element to append elements to.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/appendTo/}
     */
    function appendTo(target) {
        const appendTarget = isCheerio(target) ? target : this._make(target);
        appendTarget.append(this);
        return this;
    }
    /**
     * Insert every element in the set of matched elements to the beginning of the target.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * $('<li class="plum">Plum</li>').prependTo('#fruits');
     * $.html();
     * //=>  <ul id="fruits">
     * //      <li class="plum">Plum</li>
     * //      <li class="apple">Apple</li>
     * //      <li class="orange">Orange</li>
     * //      <li class="pear">Pear</li>
     * //    </ul>
     * ```
     *
     * @param target - Element to prepend elements to.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/prependTo/}
     */
    function prependTo(target) {
        const prependTarget = isCheerio(target) ? target : this._make(target);
        prependTarget.prepend(this);
        return this;
    }
    /**
     * Inserts content as the _last_ child of each of the selected elements.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * $('ul').append('<li class="plum">Plum</li>');
     * $.html();
     * //=>  <ul id="fruits">
     * //      <li class="apple">Apple</li>
     * //      <li class="orange">Orange</li>
     * //      <li class="pear">Pear</li>
     * //      <li class="plum">Plum</li>
     * //    </ul>
     * ```
     *
     * @see {@link https://api.jquery.com/append/}
     */
    const append = _insert((dom, children, parent) => {
        uniqueSplice(children, children.length, 0, dom, parent);
    });
    /**
     * Inserts content as the _first_ child of each of the selected elements.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * $('ul').prepend('<li class="plum">Plum</li>');
     * $.html();
     * //=>  <ul id="fruits">
     * //      <li class="plum">Plum</li>
     * //      <li class="apple">Apple</li>
     * //      <li class="orange">Orange</li>
     * //      <li class="pear">Pear</li>
     * //    </ul>
     * ```
     *
     * @see {@link https://api.jquery.com/prepend/}
     */
    const prepend = _insert((dom, children, parent) => {
        uniqueSplice(children, 0, 0, dom, parent);
    });
    function _wrap(insert) {
        return function (wrapper) {
            const lastIdx = this.length - 1;
            const lastParent = this.parents().last();
            for (let i = 0; i < this.length; i++) {
                const el = this[i];
                const wrap = typeof wrapper === 'function'
                    ? wrapper.call(el, i, el)
                    : typeof wrapper === 'string' && !isHtml(wrapper)
                        ? lastParent.find(wrapper).clone()
                        : wrapper;
                const [wrapperDom] = this._makeDomArray(wrap, i < lastIdx);
                if (!wrapperDom || !hasChildren(wrapperDom))
                    continue;
                let elInsertLocation = wrapperDom;
                /*
                 * Find the deepest child. Only consider the first tag child of each node
                 * (ignore text); stop if no children are found.
                 */
                let j = 0;
                while (j < elInsertLocation.children.length) {
                    const child = elInsertLocation.children[j];
                    if (isTag(child)) {
                        elInsertLocation = child;
                        j = 0;
                    }
                    else {
                        j++;
                    }
                }
                insert(el, elInsertLocation, [wrapperDom]);
            }
            return this;
        };
    }
    /**
     * The .wrap() function can take any string or object that could be passed to
     * the $() factory function to specify a DOM structure. This structure may be
     * nested several levels deep, but should contain only one inmost element. A
     * copy of this structure will be wrapped around each of the elements in the set
     * of matched elements. This method returns the original set of elements for
     * chaining purposes.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * const redFruit = $('<div class="red-fruit"></div>');
     * $('.apple').wrap(redFruit);
     *
     * //=> <ul id="fruits">
     * //     <div class="red-fruit">
     * //      <li class="apple">Apple</li>
     * //     </div>
     * //     <li class="orange">Orange</li>
     * //     <li class="plum">Plum</li>
     * //   </ul>
     *
     * const healthy = $('<div class="healthy"></div>');
     * $('li').wrap(healthy);
     *
     * //=> <ul id="fruits">
     * //     <div class="healthy">
     * //       <li class="apple">Apple</li>
     * //     </div>
     * //     <div class="healthy">
     * //       <li class="orange">Orange</li>
     * //     </div>
     * //     <div class="healthy">
     * //        <li class="plum">Plum</li>
     * //     </div>
     * //   </ul>
     * ```
     *
     * @param wrapper - The DOM structure to wrap around each element in the selection.
     * @see {@link https://api.jquery.com/wrap/}
     */
    const wrap = _wrap((el, elInsertLocation, wrapperDom) => {
        const { parent } = el;
        if (!parent)
            return;
        const siblings = parent.children;
        const index = siblings.indexOf(el);
        update([el], elInsertLocation);
        /*
         * The previous operation removed the current element from the `siblings`
         * array, so the `dom` array can be inserted without removing any
         * additional elements.
         */
        uniqueSplice(siblings, index, 0, wrapperDom, parent);
    });
    /**
     * The .wrapInner() function can take any string or object that could be passed
     * to the $() factory function to specify a DOM structure. This structure may be
     * nested several levels deep, but should contain only one inmost element. The
     * structure will be wrapped around the content of each of the elements in the
     * set of matched elements.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * const redFruit = $('<div class="red-fruit"></div>');
     * $('.apple').wrapInner(redFruit);
     *
     * //=> <ul id="fruits">
     * //     <li class="apple">
     * //       <div class="red-fruit">Apple</div>
     * //     </li>
     * //     <li class="orange">Orange</li>
     * //     <li class="pear">Pear</li>
     * //   </ul>
     *
     * const healthy = $('<div class="healthy"></div>');
     * $('li').wrapInner(healthy);
     *
     * //=> <ul id="fruits">
     * //     <li class="apple">
     * //       <div class="healthy">Apple</div>
     * //     </li>
     * //     <li class="orange">
     * //       <div class="healthy">Orange</div>
     * //     </li>
     * //     <li class="pear">
     * //       <div class="healthy">Pear</div>
     * //     </li>
     * //   </ul>
     * ```
     *
     * @param wrapper - The DOM structure to wrap around the content of each element
     *   in the selection.
     * @returns The instance itself, for chaining.
     * @see {@link https://api.jquery.com/wrapInner/}
     */
    const wrapInner = _wrap((el, elInsertLocation, wrapperDom) => {
        if (!hasChildren(el))
            return;
        update(el.children, elInsertLocation);
        update(wrapperDom, el);
    });
    /**
     * The .unwrap() function, removes the parents of the set of matched elements
     * from the DOM, leaving the matched elements in their place.
     *
     * @category Manipulation
     * @example <caption>without selector</caption>
     *
     * ```js
     * const $ = cheerio.load(
     *   '<div id=test>\n  <div><p>Hello</p></div>\n  <div><p>World</p></div>\n</div>'
     * );
     * $('#test p').unwrap();
     *
     * //=> <div id=test>
     * //     <p>Hello</p>
     * //     <p>World</p>
     * //   </div>
     * ```
     *
     * @example <caption>with selector</caption>
     *
     * ```js
     * const $ = cheerio.load(
     *   '<div id=test>\n  <p>Hello</p>\n  <b><p>World</p></b>\n</div>'
     * );
     * $('#test p').unwrap('b');
     *
     * //=> <div id=test>
     * //     <p>Hello</p>
     * //     <p>World</p>
     * //   </div>
     * ```
     *
     * @param selector - A selector to check the parent element against. If an
     *   element's parent does not match the selector, the element won't be unwrapped.
     * @returns The instance itself, for chaining.
     * @see {@link https://api.jquery.com/unwrap/}
     */
    function unwrap(selector) {
        this.parent(selector)
            .not('body')
            .each((_, el) => {
            this._make(el).replaceWith(el.children);
        });
        return this;
    }
    /**
     * The .wrapAll() function can take any string or object that could be passed to
     * the $() function to specify a DOM structure. This structure may be nested
     * several levels deep, but should contain only one inmost element. The
     * structure will be wrapped around all of the elements in the set of matched
     * elements, as a single group.
     *
     * @category Manipulation
     * @example <caption>With markup passed to `wrapAll`</caption>
     *
     * ```js
     * const $ = cheerio.load(
     *   '<div class="container"><div class="inner">First</div><div class="inner">Second</div></div>'
     * );
     * $('.inner').wrapAll("<div class='new'></div>");
     *
     * //=> <div class="container">
     * //     <div class='new'>
     * //       <div class="inner">First</div>
     * //       <div class="inner">Second</div>
     * //     </div>
     * //   </div>
     * ```
     *
     * @example <caption>With an existing cheerio instance</caption>
     *
     * ```js
     * const $ = cheerio.load(
     *   '<span>Span 1</span><strong>Strong</strong><span>Span 2</span>'
     * );
     * const wrap = $('<div><p><em><b></b></em></p></div>');
     * $('span').wrapAll(wrap);
     *
     * //=> <div>
     * //     <p>
     * //       <em>
     * //         <b>
     * //           <span>Span 1</span>
     * //           <span>Span 2</span>
     * //         </b>
     * //       </em>
     * //     </p>
     * //   </div>
     * //   <strong>Strong</strong>
     * ```
     *
     * @param wrapper - The DOM structure to wrap around all matched elements in the
     *   selection.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/wrapAll/}
     */
    function wrapAll(wrapper) {
        const el = this[0];
        if (el) {
            const wrap = this._make(typeof wrapper === 'function' ? wrapper.call(el, 0, el) : wrapper).insertBefore(el);
            // If html is given as wrapper, wrap may contain text elements
            let elInsertLocation;
            for (let i = 0; i < wrap.length; i++) {
                if (wrap[i].type === 'tag')
                    elInsertLocation = wrap[i];
            }
            let j = 0;
            /*
             * Find the deepest child. Only consider the first tag child of each node
             * (ignore text); stop if no children are found.
             */
            while (elInsertLocation && j < elInsertLocation.children.length) {
                const child = elInsertLocation.children[j];
                if (child.type === 'tag') {
                    elInsertLocation = child;
                    j = 0;
                }
                else {
                    j++;
                }
            }
            if (elInsertLocation)
                this._make(elInsertLocation).append(this);
        }
        return this;
    }
    /* eslint-disable jsdoc/check-param-names*/
    /**
     * Insert content next to each element in the set of matched elements.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * $('.apple').after('<li class="plum">Plum</li>');
     * $.html();
     * //=>  <ul id="fruits">
     * //      <li class="apple">Apple</li>
     * //      <li class="plum">Plum</li>
     * //      <li class="orange">Orange</li>
     * //      <li class="pear">Pear</li>
     * //    </ul>
     * ```
     *
     * @param content - HTML string, DOM element, array of DOM elements or Cheerio
     *   to insert after each element in the set of matched elements.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/after/}
     */
    function after(...elems) {
        const lastIdx = this.length - 1;
        return domEach(this, (el, i) => {
            const { parent } = el;
            if (!hasChildren(el) || !parent) {
                return;
            }
            const siblings = parent.children;
            const index = siblings.indexOf(el);
            // If not found, move on
            /* istanbul ignore next */
            if (index < 0)
                return;
            const domSrc = typeof elems[0] === 'function'
                ? elems[0].call(el, i, this._render(el.children))
                : elems;
            const dom = this._makeDomArray(domSrc, i < lastIdx);
            // Add element after `this` element
            uniqueSplice(siblings, index + 1, 0, dom, parent);
        });
    }
    /* eslint-enable jsdoc/check-param-names*/
    /**
     * Insert every element in the set of matched elements after the target.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * $('<li class="plum">Plum</li>').insertAfter('.apple');
     * $.html();
     * //=>  <ul id="fruits">
     * //      <li class="apple">Apple</li>
     * //      <li class="plum">Plum</li>
     * //      <li class="orange">Orange</li>
     * //      <li class="pear">Pear</li>
     * //    </ul>
     * ```
     *
     * @param target - Element to insert elements after.
     * @returns The set of newly inserted elements.
     * @see {@link https://api.jquery.com/insertAfter/}
     */
    function insertAfter(target) {
        if (typeof target === 'string') {
            target = this._make(target);
        }
        this.remove();
        const clones = [];
        this._makeDomArray(target).forEach((el) => {
            const clonedSelf = this.clone().toArray();
            const { parent } = el;
            if (!parent) {
                return;
            }
            const siblings = parent.children;
            const index = siblings.indexOf(el);
            // If not found, move on
            /* istanbul ignore next */
            if (index < 0)
                return;
            // Add cloned `this` element(s) after target element
            uniqueSplice(siblings, index + 1, 0, clonedSelf, parent);
            clones.push(...clonedSelf);
        });
        return this._make(clones);
    }
    /* eslint-disable jsdoc/check-param-names*/
    /**
     * Insert content previous to each element in the set of matched elements.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * $('.apple').before('<li class="plum">Plum</li>');
     * $.html();
     * //=>  <ul id="fruits">
     * //      <li class="plum">Plum</li>
     * //      <li class="apple">Apple</li>
     * //      <li class="orange">Orange</li>
     * //      <li class="pear">Pear</li>
     * //    </ul>
     * ```
     *
     * @param content - HTML string, DOM element, array of DOM elements or Cheerio
     *   to insert before each element in the set of matched elements.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/before/}
     */
    function before(...elems) {
        const lastIdx = this.length - 1;
        return domEach(this, (el, i) => {
            const { parent } = el;
            if (!hasChildren(el) || !parent) {
                return;
            }
            const siblings = parent.children;
            const index = siblings.indexOf(el);
            // If not found, move on
            /* istanbul ignore next */
            if (index < 0)
                return;
            const domSrc = typeof elems[0] === 'function'
                ? elems[0].call(el, i, this._render(el.children))
                : elems;
            const dom = this._makeDomArray(domSrc, i < lastIdx);
            // Add element before `el` element
            uniqueSplice(siblings, index, 0, dom, parent);
        });
    }
    /* eslint-enable jsdoc/check-param-names*/
    /**
     * Insert every element in the set of matched elements before the target.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * $('<li class="plum">Plum</li>').insertBefore('.apple');
     * $.html();
     * //=>  <ul id="fruits">
     * //      <li class="plum">Plum</li>
     * //      <li class="apple">Apple</li>
     * //      <li class="orange">Orange</li>
     * //      <li class="pear">Pear</li>
     * //    </ul>
     * ```
     *
     * @param target - Element to insert elements before.
     * @returns The set of newly inserted elements.
     * @see {@link https://api.jquery.com/insertBefore/}
     */
    function insertBefore(target) {
        const targetArr = this._make(target);
        this.remove();
        const clones = [];
        domEach(targetArr, (el) => {
            const clonedSelf = this.clone().toArray();
            const { parent } = el;
            if (!parent) {
                return;
            }
            const siblings = parent.children;
            const index = siblings.indexOf(el);
            // If not found, move on
            /* istanbul ignore next */
            if (index < 0)
                return;
            // Add cloned `this` element(s) after target element
            uniqueSplice(siblings, index, 0, clonedSelf, parent);
            clones.push(...clonedSelf);
        });
        return this._make(clones);
    }
    /**
     * Removes the set of matched elements from the DOM and all their children.
     * `selector` filters the set of matched elements to be removed.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * $('.pear').remove();
     * $.html();
     * //=>  <ul id="fruits">
     * //      <li class="apple">Apple</li>
     * //      <li class="orange">Orange</li>
     * //    </ul>
     * ```
     *
     * @param selector - Optional selector for elements to remove.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/remove/}
     */
    function remove(selector) {
        // Filter if we have selector
        const elems = selector ? this.filter(selector) : this;
        domEach(elems, (el) => {
            removeElement(el);
            el.prev = el.next = el.parent = null;
        });
        return this;
    }
    /**
     * Replaces matched elements with `content`.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * const plum = $('<li class="plum">Plum</li>');
     * $('.pear').replaceWith(plum);
     * $.html();
     * //=> <ul id="fruits">
     * //     <li class="apple">Apple</li>
     * //     <li class="orange">Orange</li>
     * //     <li class="plum">Plum</li>
     * //   </ul>
     * ```
     *
     * @param content - Replacement for matched elements.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/replaceWith/}
     */
    function replaceWith(content) {
        return domEach(this, (el, i) => {
            const { parent } = el;
            if (!parent) {
                return;
            }
            const siblings = parent.children;
            const cont = typeof content === 'function' ? content.call(el, i, el) : content;
            const dom = this._makeDomArray(cont);
            /*
             * In the case that `dom` contains nodes that already exist in other
             * structures, ensure those nodes are properly removed.
             */
            update(dom, null);
            const index = siblings.indexOf(el);
            // Completely remove old element
            uniqueSplice(siblings, index, 1, dom, parent);
            if (!dom.includes(el)) {
                el.parent = el.prev = el.next = null;
            }
        });
    }
    /**
     * Empties an element, removing all its children.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * $('ul').empty();
     * $.html();
     * //=>  <ul id="fruits"></ul>
     * ```
     *
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/empty/}
     */
    function empty() {
        return domEach(this, (el) => {
            if (!hasChildren(el))
                return;
            el.children.forEach((child) => {
                child.next = child.prev = child.parent = null;
            });
            el.children.length = 0;
        });
    }
    function html(str) {
        if (str === undefined) {
            const el = this[0];
            if (!el || !hasChildren(el))
                return null;
            return this._render(el.children);
        }
        return domEach(this, (el) => {
            if (!hasChildren(el))
                return;
            el.children.forEach((child) => {
                child.next = child.prev = child.parent = null;
            });
            const content = isCheerio(str)
                ? str.toArray()
                : this._parse(`${str}`, this.options, false, el).children;
            update(content, el);
        });
    }
    /**
     * Turns the collection to a string. Alias for `.html()`.
     *
     * @category Manipulation
     * @returns The rendered document.
     */
    function toString() {
        return this._render(this);
    }
    function text(str) {
        // If `str` is undefined, act as a "getter"
        if (str === undefined) {
            return text$1(this);
        }
        if (typeof str === 'function') {
            // Function support
            return domEach(this, (el, i) => this._make(el).text(str.call(el, i, text$1([el]))));
        }
        // Append text node to each selected elements
        return domEach(this, (el) => {
            if (!hasChildren(el))
                return;
            el.children.forEach((child) => {
                child.next = child.prev = child.parent = null;
            });
            const textNode = new Text(`${str}`);
            update(textNode, el);
        });
    }
    /**
     * Clone the cheerio object.
     *
     * @category Manipulation
     * @example
     *
     * ```js
     * const moreFruit = $('#fruits').clone();
     * ```
     *
     * @returns The cloned object.
     * @see {@link https://api.jquery.com/clone/}
     */
    function clone() {
        return this._make(cloneDom(this.get()));
    }

    var Manipulation = /*#__PURE__*/Object.freeze({
        __proto__: null,
        _makeDomArray: _makeDomArray,
        appendTo: appendTo,
        prependTo: prependTo,
        append: append,
        prepend: prepend,
        wrap: wrap,
        wrapInner: wrapInner,
        unwrap: unwrap,
        wrapAll: wrapAll,
        after: after,
        insertAfter: insertAfter,
        before: before,
        insertBefore: insertBefore,
        remove: remove,
        replaceWith: replaceWith,
        empty: empty,
        html: html,
        toString: toString,
        text: text,
        clone: clone
    });

    /**
     * Set multiple CSS properties for every matched element.
     *
     * @category CSS
     * @param prop - The names of the properties.
     * @param val - The new values.
     * @returns The instance itself.
     * @see {@link https://api.jquery.com/css/}
     */
    function css(prop, val) {
        if ((prop != null && val != null) ||
            // When `prop` is a "plain" object
            (typeof prop === 'object' && !Array.isArray(prop))) {
            return domEach(this, (el, i) => {
                if (isTag(el)) {
                    // `prop` can't be an array here anymore.
                    setCss(el, prop, val, i);
                }
            });
        }
        if (this.length === 0) {
            return undefined;
        }
        return getCss(this[0], prop);
    }
    /**
     * Set styles of all elements.
     *
     * @private
     * @param el - Element to set style of.
     * @param prop - Name of property.
     * @param value - Value to set property to.
     * @param idx - Optional index within the selection.
     */
    function setCss(el, prop, value, idx) {
        if (typeof prop === 'string') {
            const styles = getCss(el);
            const val = typeof value === 'function' ? value.call(el, idx, styles[prop]) : value;
            if (val === '') {
                delete styles[prop];
            }
            else if (val != null) {
                styles[prop] = val;
            }
            el.attribs['style'] = stringify(styles);
        }
        else if (typeof prop === 'object') {
            Object.keys(prop).forEach((k, i) => {
                setCss(el, k, prop[k], i);
            });
        }
    }
    function getCss(el, prop) {
        if (!el || !isTag(el))
            return;
        const styles = parse$2(el.attribs['style']);
        if (typeof prop === 'string') {
            return styles[prop];
        }
        if (Array.isArray(prop)) {
            const newStyles = {};
            prop.forEach((item) => {
                if (styles[item] != null) {
                    newStyles[item] = styles[item];
                }
            });
            return newStyles;
        }
        return styles;
    }
    /**
     * Stringify `obj` to styles.
     *
     * @private
     * @category CSS
     * @param obj - Object to stringify.
     * @returns The serialized styles.
     */
    function stringify(obj) {
        return Object.keys(obj).reduce((str, prop) => `${str}${str ? ' ' : ''}${prop}: ${obj[prop]};`, '');
    }
    /**
     * Parse `styles`.
     *
     * @private
     * @category CSS
     * @param styles - Styles to be parsed.
     * @returns The parsed styles.
     */
    function parse$2(styles) {
        styles = (styles || '').trim();
        if (!styles)
            return {};
        const obj = {};
        let key;
        for (const str of styles.split(';')) {
            const n = str.indexOf(':');
            // If there is no :, or if it is the first/last character, add to the previous item's value
            if (n < 1 || n === str.length - 1) {
                const trimmed = str.trimEnd();
                if (trimmed.length > 0 && key !== undefined) {
                    obj[key] += `;${trimmed}`;
                }
            }
            else {
                key = str.slice(0, n).trim();
                obj[key] = str.slice(n + 1).trim();
            }
        }
        return obj;
    }

    var Css = /*#__PURE__*/Object.freeze({
        __proto__: null,
        css: css
    });

    /*
     * https://github.com/jquery/jquery/blob/2.1.3/src/manipulation/var/rcheckableType.js
     * https://github.com/jquery/jquery/blob/2.1.3/src/serialize.js
     */
    const submittableSelector = 'input,select,textarea,keygen';
    const r20 = /%20/g;
    const rCRLF = /\r?\n/g;
    /**
     * Encode a set of form elements as a string for submission.
     *
     * @category Forms
     * @example
     *
     * ```js
     * $('<form><input name="foo" value="bar" /></form>').serialize();
     * //=> 'foo=bar'
     * ```
     *
     * @returns The serialized form.
     * @see {@link https://api.jquery.com/serialize/}
     */
    function serialize() {
        // Convert form elements into name/value objects
        const arr = this.serializeArray();
        // Serialize each element into a key/value string
        const retArr = arr.map((data) => `${encodeURIComponent(data.name)}=${encodeURIComponent(data.value)}`);
        // Return the resulting serialization
        return retArr.join('&').replace(r20, '+');
    }
    /**
     * Encode a set of form elements as an array of names and values.
     *
     * @category Forms
     * @example
     *
     * ```js
     * $('<form><input name="foo" value="bar" /></form>').serializeArray();
     * //=> [ { name: 'foo', value: 'bar' } ]
     * ```
     *
     * @returns The serialized form.
     * @see {@link https://api.jquery.com/serializeArray/}
     */
    function serializeArray() {
        // Resolve all form elements from either forms or collections of form elements
        return this.map((_, elem) => {
            const $elem = this._make(elem);
            if (isTag(elem) && elem.name === 'form') {
                return $elem.find(submittableSelector).toArray();
            }
            return $elem.filter(submittableSelector).toArray();
        })
            .filter(
        // Verify elements have a name (`attr.name`) and are not disabled (`:enabled`)
        '[name!=""]:enabled' +
            // And cannot be clicked (`[type=submit]`) or are used in `x-www-form-urlencoded` (`[type=file]`)
            ':not(:submit, :button, :image, :reset, :file)' +
            // And are either checked/don't have a checkable state
            ':matches([checked], :not(:checkbox, :radio))'
        // Convert each of the elements to its value(s)
        )
            .map((_, elem) => {
            var _a;
            const $elem = this._make(elem);
            const name = $elem.attr('name'); // We have filtered for elements with a name before.
            // If there is no value set (e.g. `undefined`, `null`), then default value to empty
            const value = (_a = $elem.val()) !== null && _a !== void 0 ? _a : '';
            // If we have an array of values (e.g. `<select multiple>`), return an array of key/value pairs
            if (Array.isArray(value)) {
                return value.map((val) => 
                /*
                 * We trim replace any line endings (e.g. `\r` or `\r\n` with `\r\n`) to guarantee consistency across platforms
                 * These can occur inside of `<textarea>'s`
                 */
                ({ name, value: val.replace(rCRLF, '\r\n') }));
            }
            // Otherwise (e.g. `<input type="text">`, return only one key/value pair
            return { name, value: value.replace(rCRLF, '\r\n') };
        })
            .toArray();
    }

    var Forms = /*#__PURE__*/Object.freeze({
        __proto__: null,
        serialize: serialize,
        serializeArray: serializeArray
    });

    class Cheerio {
        /**
         * Instance of cheerio. Methods are specified in the modules. Usage of this
         * constructor is not recommended. Please use `$.load` instead.
         *
         * @private
         * @param elements - The new selection.
         * @param root - Sets the root node.
         * @param options - Options for the instance.
         */
        constructor(elements, root, options) {
            this.length = 0;
            this.options = options;
            this._root = root;
            if (elements) {
                for (let idx = 0; idx < elements.length; idx++) {
                    this[idx] = elements[idx];
                }
                this.length = elements.length;
            }
        }
    }
    /** Set a signature of the object. */
    Cheerio.prototype.cheerio = '[cheerio object]';
    /*
     * Make cheerio an array-like object
     */
    Cheerio.prototype.splice = Array.prototype.splice;
    // Support for (const element of $(...)) iteration:
    Cheerio.prototype[Symbol.iterator] = Array.prototype[Symbol.iterator];
    // Plug in the API
    Object.assign(Cheerio.prototype, Attributes, Traversing, Manipulation, Css, Forms);

    function getLoad(parse, render) {
        /**
         * Create a querying function, bound to a document created from the provided markup.
         *
         * Note that similar to web browser contexts, this operation may introduce
         * `<html>`, `<head>`, and `<body>` elements; set `isDocument` to `false` to
         * switch to fragment mode and disable this.
         *
         * @param content - Markup to be loaded.
         * @param options - Options for the created instance.
         * @param isDocument - Allows parser to be switched to fragment mode.
         * @returns The loaded document.
         * @see {@link https://cheerio.js.org#loading} for additional usage information.
         */
        return function load(content, options, isDocument = true) {
            if (content == null) {
                throw new Error('cheerio.load() expects a string');
            }
            const internalOpts = { ...defaultOpts$2, ...flatten(options) };
            const initialRoot = parse(content, internalOpts, isDocument, null);
            /** Create an extended class here, so that extensions only live on one instance. */
            class LoadedCheerio extends Cheerio {
                _make(selector, context) {
                    const cheerio = initialize(selector, context);
                    cheerio.prevObject = this;
                    return cheerio;
                }
                _parse(content, options, isDocument, context) {
                    return parse(content, options, isDocument, context);
                }
                _render(dom) {
                    return render(dom, this.options);
                }
            }
            function initialize(selector, context, root = initialRoot, opts) {
                // $($)
                if (selector && isCheerio(selector))
                    return selector;
                const options = {
                    ...internalOpts,
                    ...flatten(opts),
                };
                const r = typeof root === 'string'
                    ? [parse(root, options, false, null)]
                    : 'length' in root
                        ? root
                        : [root];
                const rootInstance = isCheerio(r)
                    ? r
                    : new LoadedCheerio(r, null, options);
                // Add a cyclic reference, so that calling methods on `_root` never fails.
                rootInstance._root = rootInstance;
                // $(), $(null), $(undefined), $(false)
                if (!selector) {
                    return new LoadedCheerio(undefined, rootInstance, options);
                }
                const elements = typeof selector === 'string' && isHtml(selector)
                    ? // $(<html>)
                        parse(selector, options, false, null).children
                    : isNode(selector)
                        ? // $(dom)
                            [selector]
                        : Array.isArray(selector)
                            ? // $([dom])
                                selector
                            : undefined;
                const instance = new LoadedCheerio(elements, rootInstance, options);
                if (elements) {
                    return instance;
                }
                if (typeof selector !== 'string') {
                    throw new Error('Unexpected type of selector');
                }
                // We know that our selector is a string now.
                let search = selector;
                const searchContext = !context
                    ? // If we don't have a context, maybe we have a root, from loading
                        rootInstance
                    : typeof context === 'string'
                        ? isHtml(context)
                            ? // $('li', '<ul>...</ul>')
                                new LoadedCheerio([parse(context, options, false, null)], rootInstance, options)
                            : // $('li', 'ul')
                                ((search = `${context} ${search}`), rootInstance)
                        : isCheerio(context)
                            ? // $('li', $)
                                context
                            : // $('li', node), $('li', [nodes])
                                new LoadedCheerio(Array.isArray(context) ? context : [context], rootInstance, options);
                // If we still don't have a context, return
                if (!searchContext)
                    return instance;
                /*
                 * #id, .class, tag
                 */
                return searchContext.find(search);
            }
            // Add in static methods & properties
            Object.assign(initialize, staticMethods, {
                load,
                // `_root` and `_options` are used in static methods.
                _root: initialRoot,
                _options: internalOpts,
                // Add `fn` for plugins
                fn: LoadedCheerio.prototype,
                // Add the prototype here to maintain `instanceof` behavior.
                prototype: LoadedCheerio.prototype,
            });
            return initialize;
        };
    }
    function isNode(obj) {
        return (!!obj.name ||
            obj.type === 'root' ||
            obj.type === 'text' ||
            obj.type === 'comment');
    }

    const UNDEFINED_CODE_POINTS = new Set([
        65534, 65535, 131070, 131071, 196606, 196607, 262142, 262143, 327678, 327679, 393214,
        393215, 458750, 458751, 524286, 524287, 589822, 589823, 655358, 655359, 720894,
        720895, 786430, 786431, 851966, 851967, 917502, 917503, 983038, 983039, 1048574,
        1048575, 1114110, 1114111,
    ]);
    const REPLACEMENT_CHARACTER = '\uFFFD';
    var CODE_POINTS;
    (function (CODE_POINTS) {
        CODE_POINTS[CODE_POINTS["EOF"] = -1] = "EOF";
        CODE_POINTS[CODE_POINTS["NULL"] = 0] = "NULL";
        CODE_POINTS[CODE_POINTS["TABULATION"] = 9] = "TABULATION";
        CODE_POINTS[CODE_POINTS["CARRIAGE_RETURN"] = 13] = "CARRIAGE_RETURN";
        CODE_POINTS[CODE_POINTS["LINE_FEED"] = 10] = "LINE_FEED";
        CODE_POINTS[CODE_POINTS["FORM_FEED"] = 12] = "FORM_FEED";
        CODE_POINTS[CODE_POINTS["SPACE"] = 32] = "SPACE";
        CODE_POINTS[CODE_POINTS["EXCLAMATION_MARK"] = 33] = "EXCLAMATION_MARK";
        CODE_POINTS[CODE_POINTS["QUOTATION_MARK"] = 34] = "QUOTATION_MARK";
        CODE_POINTS[CODE_POINTS["NUMBER_SIGN"] = 35] = "NUMBER_SIGN";
        CODE_POINTS[CODE_POINTS["AMPERSAND"] = 38] = "AMPERSAND";
        CODE_POINTS[CODE_POINTS["APOSTROPHE"] = 39] = "APOSTROPHE";
        CODE_POINTS[CODE_POINTS["HYPHEN_MINUS"] = 45] = "HYPHEN_MINUS";
        CODE_POINTS[CODE_POINTS["SOLIDUS"] = 47] = "SOLIDUS";
        CODE_POINTS[CODE_POINTS["DIGIT_0"] = 48] = "DIGIT_0";
        CODE_POINTS[CODE_POINTS["DIGIT_9"] = 57] = "DIGIT_9";
        CODE_POINTS[CODE_POINTS["SEMICOLON"] = 59] = "SEMICOLON";
        CODE_POINTS[CODE_POINTS["LESS_THAN_SIGN"] = 60] = "LESS_THAN_SIGN";
        CODE_POINTS[CODE_POINTS["EQUALS_SIGN"] = 61] = "EQUALS_SIGN";
        CODE_POINTS[CODE_POINTS["GREATER_THAN_SIGN"] = 62] = "GREATER_THAN_SIGN";
        CODE_POINTS[CODE_POINTS["QUESTION_MARK"] = 63] = "QUESTION_MARK";
        CODE_POINTS[CODE_POINTS["LATIN_CAPITAL_A"] = 65] = "LATIN_CAPITAL_A";
        CODE_POINTS[CODE_POINTS["LATIN_CAPITAL_F"] = 70] = "LATIN_CAPITAL_F";
        CODE_POINTS[CODE_POINTS["LATIN_CAPITAL_X"] = 88] = "LATIN_CAPITAL_X";
        CODE_POINTS[CODE_POINTS["LATIN_CAPITAL_Z"] = 90] = "LATIN_CAPITAL_Z";
        CODE_POINTS[CODE_POINTS["RIGHT_SQUARE_BRACKET"] = 93] = "RIGHT_SQUARE_BRACKET";
        CODE_POINTS[CODE_POINTS["GRAVE_ACCENT"] = 96] = "GRAVE_ACCENT";
        CODE_POINTS[CODE_POINTS["LATIN_SMALL_A"] = 97] = "LATIN_SMALL_A";
        CODE_POINTS[CODE_POINTS["LATIN_SMALL_F"] = 102] = "LATIN_SMALL_F";
        CODE_POINTS[CODE_POINTS["LATIN_SMALL_X"] = 120] = "LATIN_SMALL_X";
        CODE_POINTS[CODE_POINTS["LATIN_SMALL_Z"] = 122] = "LATIN_SMALL_Z";
        CODE_POINTS[CODE_POINTS["REPLACEMENT_CHARACTER"] = 65533] = "REPLACEMENT_CHARACTER";
    })(CODE_POINTS || (CODE_POINTS = {}));
    const SEQUENCES = {
        DASH_DASH: '--',
        CDATA_START: '[CDATA[',
        DOCTYPE: 'doctype',
        SCRIPT: 'script',
        PUBLIC: 'public',
        SYSTEM: 'system',
    };
    //Surrogates
    function isSurrogate(cp) {
        return cp >= 55296 && cp <= 57343;
    }
    function isSurrogatePair(cp) {
        return cp >= 56320 && cp <= 57343;
    }
    function getSurrogatePairCodePoint(cp1, cp2) {
        return (cp1 - 55296) * 1024 + 9216 + cp2;
    }
    //NOTE: excluding NULL and ASCII whitespace
    function isControlCodePoint(cp) {
        return ((cp !== 0x20 && cp !== 0x0a && cp !== 0x0d && cp !== 0x09 && cp !== 0x0c && cp >= 0x01 && cp <= 0x1f) ||
            (cp >= 0x7f && cp <= 0x9f));
    }
    function isUndefinedCodePoint(cp) {
        return (cp >= 64976 && cp <= 65007) || UNDEFINED_CODE_POINTS.has(cp);
    }

    var ERR;
    (function (ERR) {
        ERR["controlCharacterInInputStream"] = "control-character-in-input-stream";
        ERR["noncharacterInInputStream"] = "noncharacter-in-input-stream";
        ERR["surrogateInInputStream"] = "surrogate-in-input-stream";
        ERR["nonVoidHtmlElementStartTagWithTrailingSolidus"] = "non-void-html-element-start-tag-with-trailing-solidus";
        ERR["endTagWithAttributes"] = "end-tag-with-attributes";
        ERR["endTagWithTrailingSolidus"] = "end-tag-with-trailing-solidus";
        ERR["unexpectedSolidusInTag"] = "unexpected-solidus-in-tag";
        ERR["unexpectedNullCharacter"] = "unexpected-null-character";
        ERR["unexpectedQuestionMarkInsteadOfTagName"] = "unexpected-question-mark-instead-of-tag-name";
        ERR["invalidFirstCharacterOfTagName"] = "invalid-first-character-of-tag-name";
        ERR["unexpectedEqualsSignBeforeAttributeName"] = "unexpected-equals-sign-before-attribute-name";
        ERR["missingEndTagName"] = "missing-end-tag-name";
        ERR["unexpectedCharacterInAttributeName"] = "unexpected-character-in-attribute-name";
        ERR["unknownNamedCharacterReference"] = "unknown-named-character-reference";
        ERR["missingSemicolonAfterCharacterReference"] = "missing-semicolon-after-character-reference";
        ERR["unexpectedCharacterAfterDoctypeSystemIdentifier"] = "unexpected-character-after-doctype-system-identifier";
        ERR["unexpectedCharacterInUnquotedAttributeValue"] = "unexpected-character-in-unquoted-attribute-value";
        ERR["eofBeforeTagName"] = "eof-before-tag-name";
        ERR["eofInTag"] = "eof-in-tag";
        ERR["missingAttributeValue"] = "missing-attribute-value";
        ERR["missingWhitespaceBetweenAttributes"] = "missing-whitespace-between-attributes";
        ERR["missingWhitespaceAfterDoctypePublicKeyword"] = "missing-whitespace-after-doctype-public-keyword";
        ERR["missingWhitespaceBetweenDoctypePublicAndSystemIdentifiers"] = "missing-whitespace-between-doctype-public-and-system-identifiers";
        ERR["missingWhitespaceAfterDoctypeSystemKeyword"] = "missing-whitespace-after-doctype-system-keyword";
        ERR["missingQuoteBeforeDoctypePublicIdentifier"] = "missing-quote-before-doctype-public-identifier";
        ERR["missingQuoteBeforeDoctypeSystemIdentifier"] = "missing-quote-before-doctype-system-identifier";
        ERR["missingDoctypePublicIdentifier"] = "missing-doctype-public-identifier";
        ERR["missingDoctypeSystemIdentifier"] = "missing-doctype-system-identifier";
        ERR["abruptDoctypePublicIdentifier"] = "abrupt-doctype-public-identifier";
        ERR["abruptDoctypeSystemIdentifier"] = "abrupt-doctype-system-identifier";
        ERR["cdataInHtmlContent"] = "cdata-in-html-content";
        ERR["incorrectlyOpenedComment"] = "incorrectly-opened-comment";
        ERR["eofInScriptHtmlCommentLikeText"] = "eof-in-script-html-comment-like-text";
        ERR["eofInDoctype"] = "eof-in-doctype";
        ERR["nestedComment"] = "nested-comment";
        ERR["abruptClosingOfEmptyComment"] = "abrupt-closing-of-empty-comment";
        ERR["eofInComment"] = "eof-in-comment";
        ERR["incorrectlyClosedComment"] = "incorrectly-closed-comment";
        ERR["eofInCdata"] = "eof-in-cdata";
        ERR["absenceOfDigitsInNumericCharacterReference"] = "absence-of-digits-in-numeric-character-reference";
        ERR["nullCharacterReference"] = "null-character-reference";
        ERR["surrogateCharacterReference"] = "surrogate-character-reference";
        ERR["characterReferenceOutsideUnicodeRange"] = "character-reference-outside-unicode-range";
        ERR["controlCharacterReference"] = "control-character-reference";
        ERR["noncharacterCharacterReference"] = "noncharacter-character-reference";
        ERR["missingWhitespaceBeforeDoctypeName"] = "missing-whitespace-before-doctype-name";
        ERR["missingDoctypeName"] = "missing-doctype-name";
        ERR["invalidCharacterSequenceAfterDoctypeName"] = "invalid-character-sequence-after-doctype-name";
        ERR["duplicateAttribute"] = "duplicate-attribute";
        ERR["nonConformingDoctype"] = "non-conforming-doctype";
        ERR["missingDoctype"] = "missing-doctype";
        ERR["misplacedDoctype"] = "misplaced-doctype";
        ERR["endTagWithoutMatchingOpenElement"] = "end-tag-without-matching-open-element";
        ERR["closingOfElementWithOpenChildElements"] = "closing-of-element-with-open-child-elements";
        ERR["disallowedContentInNoscriptInHead"] = "disallowed-content-in-noscript-in-head";
        ERR["openElementsLeftAfterEof"] = "open-elements-left-after-eof";
        ERR["abandonedHeadElementChild"] = "abandoned-head-element-child";
        ERR["misplacedStartTagForHeadElement"] = "misplaced-start-tag-for-head-element";
        ERR["nestedNoscriptInHead"] = "nested-noscript-in-head";
        ERR["eofInElementThatCanContainOnlyText"] = "eof-in-element-that-can-contain-only-text";
    })(ERR || (ERR = {}));

    //Const
    const DEFAULT_BUFFER_WATERLINE = 1 << 16;
    //Preprocessor
    //NOTE: HTML input preprocessing
    //(see: http://www.whatwg.org/specs/web-apps/current-work/multipage/parsing.html#preprocessing-the-input-stream)
    class Preprocessor {
        constructor(handler) {
            this.handler = handler;
            this.html = '';
            this.pos = -1;
            // NOTE: Initial `lastGapPos` is -2, to ensure `col` on initialisation is 0
            this.lastGapPos = -2;
            this.gapStack = [];
            this.skipNextNewLine = false;
            this.lastChunkWritten = false;
            this.endOfChunkHit = false;
            this.bufferWaterline = DEFAULT_BUFFER_WATERLINE;
            this.isEol = false;
            this.lineStartPos = 0;
            this.droppedBufferSize = 0;
            this.line = 1;
            //NOTE: avoid reporting errors twice on advance/retreat
            this.lastErrOffset = -1;
        }
        /** The column on the current line. If we just saw a gap (eg. a surrogate pair), return the index before. */
        get col() {
            return this.pos - this.lineStartPos + Number(this.lastGapPos !== this.pos);
        }
        get offset() {
            return this.droppedBufferSize + this.pos;
        }
        getError(code) {
            const { line, col, offset } = this;
            return {
                code,
                startLine: line,
                endLine: line,
                startCol: col,
                endCol: col,
                startOffset: offset,
                endOffset: offset,
            };
        }
        _err(code) {
            if (this.handler.onParseError && this.lastErrOffset !== this.offset) {
                this.lastErrOffset = this.offset;
                this.handler.onParseError(this.getError(code));
            }
        }
        _addGap() {
            this.gapStack.push(this.lastGapPos);
            this.lastGapPos = this.pos;
        }
        _processSurrogate(cp) {
            //NOTE: try to peek a surrogate pair
            if (this.pos !== this.html.length - 1) {
                const nextCp = this.html.charCodeAt(this.pos + 1);
                if (isSurrogatePair(nextCp)) {
                    //NOTE: we have a surrogate pair. Peek pair character and recalculate code point.
                    this.pos++;
                    //NOTE: add a gap that should be avoided during retreat
                    this._addGap();
                    return getSurrogatePairCodePoint(cp, nextCp);
                }
            }
            //NOTE: we are at the end of a chunk, therefore we can't infer the surrogate pair yet.
            else if (!this.lastChunkWritten) {
                this.endOfChunkHit = true;
                return CODE_POINTS.EOF;
            }
            //NOTE: isolated surrogate
            this._err(ERR.surrogateInInputStream);
            return cp;
        }
        willDropParsedChunk() {
            return this.pos > this.bufferWaterline;
        }
        dropParsedChunk() {
            if (this.willDropParsedChunk()) {
                this.html = this.html.substring(this.pos);
                this.lineStartPos -= this.pos;
                this.droppedBufferSize += this.pos;
                this.pos = 0;
                this.lastGapPos = -2;
                this.gapStack.length = 0;
            }
        }
        write(chunk, isLastChunk) {
            if (this.html.length > 0) {
                this.html += chunk;
            }
            else {
                this.html = chunk;
            }
            this.endOfChunkHit = false;
            this.lastChunkWritten = isLastChunk;
        }
        insertHtmlAtCurrentPos(chunk) {
            this.html = this.html.substring(0, this.pos + 1) + chunk + this.html.substring(this.pos + 1);
            this.endOfChunkHit = false;
        }
        startsWith(pattern, caseSensitive) {
            // Check if our buffer has enough characters
            if (this.pos + pattern.length > this.html.length) {
                this.endOfChunkHit = !this.lastChunkWritten;
                return false;
            }
            if (caseSensitive) {
                return this.html.startsWith(pattern, this.pos);
            }
            for (let i = 0; i < pattern.length; i++) {
                const cp = this.html.charCodeAt(this.pos + i) | 0x20;
                if (cp !== pattern.charCodeAt(i)) {
                    return false;
                }
            }
            return true;
        }
        peek(offset) {
            const pos = this.pos + offset;
            if (pos >= this.html.length) {
                this.endOfChunkHit = !this.lastChunkWritten;
                return CODE_POINTS.EOF;
            }
            return this.html.charCodeAt(pos);
        }
        advance() {
            this.pos++;
            //NOTE: LF should be in the last column of the line
            if (this.isEol) {
                this.isEol = false;
                this.line++;
                this.lineStartPos = this.pos;
            }
            if (this.pos >= this.html.length) {
                this.endOfChunkHit = !this.lastChunkWritten;
                return CODE_POINTS.EOF;
            }
            let cp = this.html.charCodeAt(this.pos);
            //NOTE: all U+000D CARRIAGE RETURN (CR) characters must be converted to U+000A LINE FEED (LF) characters
            if (cp === CODE_POINTS.CARRIAGE_RETURN) {
                this.isEol = true;
                this.skipNextNewLine = true;
                return CODE_POINTS.LINE_FEED;
            }
            //NOTE: any U+000A LINE FEED (LF) characters that immediately follow a U+000D CARRIAGE RETURN (CR) character
            //must be ignored.
            if (cp === CODE_POINTS.LINE_FEED) {
                this.isEol = true;
                if (this.skipNextNewLine) {
                    // `line` will be bumped again in the recursive call.
                    this.line--;
                    this.skipNextNewLine = false;
                    this._addGap();
                    return this.advance();
                }
            }
            this.skipNextNewLine = false;
            if (isSurrogate(cp)) {
                cp = this._processSurrogate(cp);
            }
            //OPTIMIZATION: first check if code point is in the common allowed
            //range (ASCII alphanumeric, whitespaces, big chunk of BMP)
            //before going into detailed performance cost validation.
            const isCommonValidRange = this.handler.onParseError === null ||
                (cp > 0x1f && cp < 0x7f) ||
                cp === CODE_POINTS.LINE_FEED ||
                cp === CODE_POINTS.CARRIAGE_RETURN ||
                (cp > 0x9f && cp < 64976);
            if (!isCommonValidRange) {
                this._checkForProblematicCharacters(cp);
            }
            return cp;
        }
        _checkForProblematicCharacters(cp) {
            if (isControlCodePoint(cp)) {
                this._err(ERR.controlCharacterInInputStream);
            }
            else if (isUndefinedCodePoint(cp)) {
                this._err(ERR.noncharacterInInputStream);
            }
        }
        retreat(count) {
            this.pos -= count;
            while (this.pos < this.lastGapPos) {
                this.lastGapPos = this.gapStack.pop();
                this.pos--;
            }
            this.isEol = false;
        }
    }

    var TokenType;
    (function (TokenType) {
        TokenType[TokenType["CHARACTER"] = 0] = "CHARACTER";
        TokenType[TokenType["NULL_CHARACTER"] = 1] = "NULL_CHARACTER";
        TokenType[TokenType["WHITESPACE_CHARACTER"] = 2] = "WHITESPACE_CHARACTER";
        TokenType[TokenType["START_TAG"] = 3] = "START_TAG";
        TokenType[TokenType["END_TAG"] = 4] = "END_TAG";
        TokenType[TokenType["COMMENT"] = 5] = "COMMENT";
        TokenType[TokenType["DOCTYPE"] = 6] = "DOCTYPE";
        TokenType[TokenType["EOF"] = 7] = "EOF";
        TokenType[TokenType["HIBERNATION"] = 8] = "HIBERNATION";
    })(TokenType || (TokenType = {}));
    function getTokenAttr(token, attrName) {
        for (let i = token.attrs.length - 1; i >= 0; i--) {
            if (token.attrs[i].name === attrName) {
                return token.attrs[i].value;
            }
        }
        return null;
    }

    /** All valid namespaces in HTML. */
    var NS;
    (function (NS) {
        NS["HTML"] = "http://www.w3.org/1999/xhtml";
        NS["MATHML"] = "http://www.w3.org/1998/Math/MathML";
        NS["SVG"] = "http://www.w3.org/2000/svg";
        NS["XLINK"] = "http://www.w3.org/1999/xlink";
        NS["XML"] = "http://www.w3.org/XML/1998/namespace";
        NS["XMLNS"] = "http://www.w3.org/2000/xmlns/";
    })(NS || (NS = {}));
    var ATTRS;
    (function (ATTRS) {
        ATTRS["TYPE"] = "type";
        ATTRS["ACTION"] = "action";
        ATTRS["ENCODING"] = "encoding";
        ATTRS["PROMPT"] = "prompt";
        ATTRS["NAME"] = "name";
        ATTRS["COLOR"] = "color";
        ATTRS["FACE"] = "face";
        ATTRS["SIZE"] = "size";
    })(ATTRS || (ATTRS = {}));
    /**
     * The mode of the document.
     *
     * @see {@link https://dom.spec.whatwg.org/#concept-document-limited-quirks}
     */
    var DOCUMENT_MODE;
    (function (DOCUMENT_MODE) {
        DOCUMENT_MODE["NO_QUIRKS"] = "no-quirks";
        DOCUMENT_MODE["QUIRKS"] = "quirks";
        DOCUMENT_MODE["LIMITED_QUIRKS"] = "limited-quirks";
    })(DOCUMENT_MODE || (DOCUMENT_MODE = {}));
    var TAG_NAMES;
    (function (TAG_NAMES) {
        TAG_NAMES["A"] = "a";
        TAG_NAMES["ADDRESS"] = "address";
        TAG_NAMES["ANNOTATION_XML"] = "annotation-xml";
        TAG_NAMES["APPLET"] = "applet";
        TAG_NAMES["AREA"] = "area";
        TAG_NAMES["ARTICLE"] = "article";
        TAG_NAMES["ASIDE"] = "aside";
        TAG_NAMES["B"] = "b";
        TAG_NAMES["BASE"] = "base";
        TAG_NAMES["BASEFONT"] = "basefont";
        TAG_NAMES["BGSOUND"] = "bgsound";
        TAG_NAMES["BIG"] = "big";
        TAG_NAMES["BLOCKQUOTE"] = "blockquote";
        TAG_NAMES["BODY"] = "body";
        TAG_NAMES["BR"] = "br";
        TAG_NAMES["BUTTON"] = "button";
        TAG_NAMES["CAPTION"] = "caption";
        TAG_NAMES["CENTER"] = "center";
        TAG_NAMES["CODE"] = "code";
        TAG_NAMES["COL"] = "col";
        TAG_NAMES["COLGROUP"] = "colgroup";
        TAG_NAMES["DD"] = "dd";
        TAG_NAMES["DESC"] = "desc";
        TAG_NAMES["DETAILS"] = "details";
        TAG_NAMES["DIALOG"] = "dialog";
        TAG_NAMES["DIR"] = "dir";
        TAG_NAMES["DIV"] = "div";
        TAG_NAMES["DL"] = "dl";
        TAG_NAMES["DT"] = "dt";
        TAG_NAMES["EM"] = "em";
        TAG_NAMES["EMBED"] = "embed";
        TAG_NAMES["FIELDSET"] = "fieldset";
        TAG_NAMES["FIGCAPTION"] = "figcaption";
        TAG_NAMES["FIGURE"] = "figure";
        TAG_NAMES["FONT"] = "font";
        TAG_NAMES["FOOTER"] = "footer";
        TAG_NAMES["FOREIGN_OBJECT"] = "foreignObject";
        TAG_NAMES["FORM"] = "form";
        TAG_NAMES["FRAME"] = "frame";
        TAG_NAMES["FRAMESET"] = "frameset";
        TAG_NAMES["H1"] = "h1";
        TAG_NAMES["H2"] = "h2";
        TAG_NAMES["H3"] = "h3";
        TAG_NAMES["H4"] = "h4";
        TAG_NAMES["H5"] = "h5";
        TAG_NAMES["H6"] = "h6";
        TAG_NAMES["HEAD"] = "head";
        TAG_NAMES["HEADER"] = "header";
        TAG_NAMES["HGROUP"] = "hgroup";
        TAG_NAMES["HR"] = "hr";
        TAG_NAMES["HTML"] = "html";
        TAG_NAMES["I"] = "i";
        TAG_NAMES["IMG"] = "img";
        TAG_NAMES["IMAGE"] = "image";
        TAG_NAMES["INPUT"] = "input";
        TAG_NAMES["IFRAME"] = "iframe";
        TAG_NAMES["KEYGEN"] = "keygen";
        TAG_NAMES["LABEL"] = "label";
        TAG_NAMES["LI"] = "li";
        TAG_NAMES["LINK"] = "link";
        TAG_NAMES["LISTING"] = "listing";
        TAG_NAMES["MAIN"] = "main";
        TAG_NAMES["MALIGNMARK"] = "malignmark";
        TAG_NAMES["MARQUEE"] = "marquee";
        TAG_NAMES["MATH"] = "math";
        TAG_NAMES["MENU"] = "menu";
        TAG_NAMES["META"] = "meta";
        TAG_NAMES["MGLYPH"] = "mglyph";
        TAG_NAMES["MI"] = "mi";
        TAG_NAMES["MO"] = "mo";
        TAG_NAMES["MN"] = "mn";
        TAG_NAMES["MS"] = "ms";
        TAG_NAMES["MTEXT"] = "mtext";
        TAG_NAMES["NAV"] = "nav";
        TAG_NAMES["NOBR"] = "nobr";
        TAG_NAMES["NOFRAMES"] = "noframes";
        TAG_NAMES["NOEMBED"] = "noembed";
        TAG_NAMES["NOSCRIPT"] = "noscript";
        TAG_NAMES["OBJECT"] = "object";
        TAG_NAMES["OL"] = "ol";
        TAG_NAMES["OPTGROUP"] = "optgroup";
        TAG_NAMES["OPTION"] = "option";
        TAG_NAMES["P"] = "p";
        TAG_NAMES["PARAM"] = "param";
        TAG_NAMES["PLAINTEXT"] = "plaintext";
        TAG_NAMES["PRE"] = "pre";
        TAG_NAMES["RB"] = "rb";
        TAG_NAMES["RP"] = "rp";
        TAG_NAMES["RT"] = "rt";
        TAG_NAMES["RTC"] = "rtc";
        TAG_NAMES["RUBY"] = "ruby";
        TAG_NAMES["S"] = "s";
        TAG_NAMES["SCRIPT"] = "script";
        TAG_NAMES["SECTION"] = "section";
        TAG_NAMES["SELECT"] = "select";
        TAG_NAMES["SOURCE"] = "source";
        TAG_NAMES["SMALL"] = "small";
        TAG_NAMES["SPAN"] = "span";
        TAG_NAMES["STRIKE"] = "strike";
        TAG_NAMES["STRONG"] = "strong";
        TAG_NAMES["STYLE"] = "style";
        TAG_NAMES["SUB"] = "sub";
        TAG_NAMES["SUMMARY"] = "summary";
        TAG_NAMES["SUP"] = "sup";
        TAG_NAMES["TABLE"] = "table";
        TAG_NAMES["TBODY"] = "tbody";
        TAG_NAMES["TEMPLATE"] = "template";
        TAG_NAMES["TEXTAREA"] = "textarea";
        TAG_NAMES["TFOOT"] = "tfoot";
        TAG_NAMES["TD"] = "td";
        TAG_NAMES["TH"] = "th";
        TAG_NAMES["THEAD"] = "thead";
        TAG_NAMES["TITLE"] = "title";
        TAG_NAMES["TR"] = "tr";
        TAG_NAMES["TRACK"] = "track";
        TAG_NAMES["TT"] = "tt";
        TAG_NAMES["U"] = "u";
        TAG_NAMES["UL"] = "ul";
        TAG_NAMES["SVG"] = "svg";
        TAG_NAMES["VAR"] = "var";
        TAG_NAMES["WBR"] = "wbr";
        TAG_NAMES["XMP"] = "xmp";
    })(TAG_NAMES || (TAG_NAMES = {}));
    /**
     * Tag IDs are numeric IDs for known tag names.
     *
     * We use tag IDs to improve the performance of tag name comparisons.
     */
    var TAG_ID;
    (function (TAG_ID) {
        TAG_ID[TAG_ID["UNKNOWN"] = 0] = "UNKNOWN";
        TAG_ID[TAG_ID["A"] = 1] = "A";
        TAG_ID[TAG_ID["ADDRESS"] = 2] = "ADDRESS";
        TAG_ID[TAG_ID["ANNOTATION_XML"] = 3] = "ANNOTATION_XML";
        TAG_ID[TAG_ID["APPLET"] = 4] = "APPLET";
        TAG_ID[TAG_ID["AREA"] = 5] = "AREA";
        TAG_ID[TAG_ID["ARTICLE"] = 6] = "ARTICLE";
        TAG_ID[TAG_ID["ASIDE"] = 7] = "ASIDE";
        TAG_ID[TAG_ID["B"] = 8] = "B";
        TAG_ID[TAG_ID["BASE"] = 9] = "BASE";
        TAG_ID[TAG_ID["BASEFONT"] = 10] = "BASEFONT";
        TAG_ID[TAG_ID["BGSOUND"] = 11] = "BGSOUND";
        TAG_ID[TAG_ID["BIG"] = 12] = "BIG";
        TAG_ID[TAG_ID["BLOCKQUOTE"] = 13] = "BLOCKQUOTE";
        TAG_ID[TAG_ID["BODY"] = 14] = "BODY";
        TAG_ID[TAG_ID["BR"] = 15] = "BR";
        TAG_ID[TAG_ID["BUTTON"] = 16] = "BUTTON";
        TAG_ID[TAG_ID["CAPTION"] = 17] = "CAPTION";
        TAG_ID[TAG_ID["CENTER"] = 18] = "CENTER";
        TAG_ID[TAG_ID["CODE"] = 19] = "CODE";
        TAG_ID[TAG_ID["COL"] = 20] = "COL";
        TAG_ID[TAG_ID["COLGROUP"] = 21] = "COLGROUP";
        TAG_ID[TAG_ID["DD"] = 22] = "DD";
        TAG_ID[TAG_ID["DESC"] = 23] = "DESC";
        TAG_ID[TAG_ID["DETAILS"] = 24] = "DETAILS";
        TAG_ID[TAG_ID["DIALOG"] = 25] = "DIALOG";
        TAG_ID[TAG_ID["DIR"] = 26] = "DIR";
        TAG_ID[TAG_ID["DIV"] = 27] = "DIV";
        TAG_ID[TAG_ID["DL"] = 28] = "DL";
        TAG_ID[TAG_ID["DT"] = 29] = "DT";
        TAG_ID[TAG_ID["EM"] = 30] = "EM";
        TAG_ID[TAG_ID["EMBED"] = 31] = "EMBED";
        TAG_ID[TAG_ID["FIELDSET"] = 32] = "FIELDSET";
        TAG_ID[TAG_ID["FIGCAPTION"] = 33] = "FIGCAPTION";
        TAG_ID[TAG_ID["FIGURE"] = 34] = "FIGURE";
        TAG_ID[TAG_ID["FONT"] = 35] = "FONT";
        TAG_ID[TAG_ID["FOOTER"] = 36] = "FOOTER";
        TAG_ID[TAG_ID["FOREIGN_OBJECT"] = 37] = "FOREIGN_OBJECT";
        TAG_ID[TAG_ID["FORM"] = 38] = "FORM";
        TAG_ID[TAG_ID["FRAME"] = 39] = "FRAME";
        TAG_ID[TAG_ID["FRAMESET"] = 40] = "FRAMESET";
        TAG_ID[TAG_ID["H1"] = 41] = "H1";
        TAG_ID[TAG_ID["H2"] = 42] = "H2";
        TAG_ID[TAG_ID["H3"] = 43] = "H3";
        TAG_ID[TAG_ID["H4"] = 44] = "H4";
        TAG_ID[TAG_ID["H5"] = 45] = "H5";
        TAG_ID[TAG_ID["H6"] = 46] = "H6";
        TAG_ID[TAG_ID["HEAD"] = 47] = "HEAD";
        TAG_ID[TAG_ID["HEADER"] = 48] = "HEADER";
        TAG_ID[TAG_ID["HGROUP"] = 49] = "HGROUP";
        TAG_ID[TAG_ID["HR"] = 50] = "HR";
        TAG_ID[TAG_ID["HTML"] = 51] = "HTML";
        TAG_ID[TAG_ID["I"] = 52] = "I";
        TAG_ID[TAG_ID["IMG"] = 53] = "IMG";
        TAG_ID[TAG_ID["IMAGE"] = 54] = "IMAGE";
        TAG_ID[TAG_ID["INPUT"] = 55] = "INPUT";
        TAG_ID[TAG_ID["IFRAME"] = 56] = "IFRAME";
        TAG_ID[TAG_ID["KEYGEN"] = 57] = "KEYGEN";
        TAG_ID[TAG_ID["LABEL"] = 58] = "LABEL";
        TAG_ID[TAG_ID["LI"] = 59] = "LI";
        TAG_ID[TAG_ID["LINK"] = 60] = "LINK";
        TAG_ID[TAG_ID["LISTING"] = 61] = "LISTING";
        TAG_ID[TAG_ID["MAIN"] = 62] = "MAIN";
        TAG_ID[TAG_ID["MALIGNMARK"] = 63] = "MALIGNMARK";
        TAG_ID[TAG_ID["MARQUEE"] = 64] = "MARQUEE";
        TAG_ID[TAG_ID["MATH"] = 65] = "MATH";
        TAG_ID[TAG_ID["MENU"] = 66] = "MENU";
        TAG_ID[TAG_ID["META"] = 67] = "META";
        TAG_ID[TAG_ID["MGLYPH"] = 68] = "MGLYPH";
        TAG_ID[TAG_ID["MI"] = 69] = "MI";
        TAG_ID[TAG_ID["MO"] = 70] = "MO";
        TAG_ID[TAG_ID["MN"] = 71] = "MN";
        TAG_ID[TAG_ID["MS"] = 72] = "MS";
        TAG_ID[TAG_ID["MTEXT"] = 73] = "MTEXT";
        TAG_ID[TAG_ID["NAV"] = 74] = "NAV";
        TAG_ID[TAG_ID["NOBR"] = 75] = "NOBR";
        TAG_ID[TAG_ID["NOFRAMES"] = 76] = "NOFRAMES";
        TAG_ID[TAG_ID["NOEMBED"] = 77] = "NOEMBED";
        TAG_ID[TAG_ID["NOSCRIPT"] = 78] = "NOSCRIPT";
        TAG_ID[TAG_ID["OBJECT"] = 79] = "OBJECT";
        TAG_ID[TAG_ID["OL"] = 80] = "OL";
        TAG_ID[TAG_ID["OPTGROUP"] = 81] = "OPTGROUP";
        TAG_ID[TAG_ID["OPTION"] = 82] = "OPTION";
        TAG_ID[TAG_ID["P"] = 83] = "P";
        TAG_ID[TAG_ID["PARAM"] = 84] = "PARAM";
        TAG_ID[TAG_ID["PLAINTEXT"] = 85] = "PLAINTEXT";
        TAG_ID[TAG_ID["PRE"] = 86] = "PRE";
        TAG_ID[TAG_ID["RB"] = 87] = "RB";
        TAG_ID[TAG_ID["RP"] = 88] = "RP";
        TAG_ID[TAG_ID["RT"] = 89] = "RT";
        TAG_ID[TAG_ID["RTC"] = 90] = "RTC";
        TAG_ID[TAG_ID["RUBY"] = 91] = "RUBY";
        TAG_ID[TAG_ID["S"] = 92] = "S";
        TAG_ID[TAG_ID["SCRIPT"] = 93] = "SCRIPT";
        TAG_ID[TAG_ID["SECTION"] = 94] = "SECTION";
        TAG_ID[TAG_ID["SELECT"] = 95] = "SELECT";
        TAG_ID[TAG_ID["SOURCE"] = 96] = "SOURCE";
        TAG_ID[TAG_ID["SMALL"] = 97] = "SMALL";
        TAG_ID[TAG_ID["SPAN"] = 98] = "SPAN";
        TAG_ID[TAG_ID["STRIKE"] = 99] = "STRIKE";
        TAG_ID[TAG_ID["STRONG"] = 100] = "STRONG";
        TAG_ID[TAG_ID["STYLE"] = 101] = "STYLE";
        TAG_ID[TAG_ID["SUB"] = 102] = "SUB";
        TAG_ID[TAG_ID["SUMMARY"] = 103] = "SUMMARY";
        TAG_ID[TAG_ID["SUP"] = 104] = "SUP";
        TAG_ID[TAG_ID["TABLE"] = 105] = "TABLE";
        TAG_ID[TAG_ID["TBODY"] = 106] = "TBODY";
        TAG_ID[TAG_ID["TEMPLATE"] = 107] = "TEMPLATE";
        TAG_ID[TAG_ID["TEXTAREA"] = 108] = "TEXTAREA";
        TAG_ID[TAG_ID["TFOOT"] = 109] = "TFOOT";
        TAG_ID[TAG_ID["TD"] = 110] = "TD";
        TAG_ID[TAG_ID["TH"] = 111] = "TH";
        TAG_ID[TAG_ID["THEAD"] = 112] = "THEAD";
        TAG_ID[TAG_ID["TITLE"] = 113] = "TITLE";
        TAG_ID[TAG_ID["TR"] = 114] = "TR";
        TAG_ID[TAG_ID["TRACK"] = 115] = "TRACK";
        TAG_ID[TAG_ID["TT"] = 116] = "TT";
        TAG_ID[TAG_ID["U"] = 117] = "U";
        TAG_ID[TAG_ID["UL"] = 118] = "UL";
        TAG_ID[TAG_ID["SVG"] = 119] = "SVG";
        TAG_ID[TAG_ID["VAR"] = 120] = "VAR";
        TAG_ID[TAG_ID["WBR"] = 121] = "WBR";
        TAG_ID[TAG_ID["XMP"] = 122] = "XMP";
    })(TAG_ID || (TAG_ID = {}));
    const TAG_NAME_TO_ID = new Map([
        [TAG_NAMES.A, TAG_ID.A],
        [TAG_NAMES.ADDRESS, TAG_ID.ADDRESS],
        [TAG_NAMES.ANNOTATION_XML, TAG_ID.ANNOTATION_XML],
        [TAG_NAMES.APPLET, TAG_ID.APPLET],
        [TAG_NAMES.AREA, TAG_ID.AREA],
        [TAG_NAMES.ARTICLE, TAG_ID.ARTICLE],
        [TAG_NAMES.ASIDE, TAG_ID.ASIDE],
        [TAG_NAMES.B, TAG_ID.B],
        [TAG_NAMES.BASE, TAG_ID.BASE],
        [TAG_NAMES.BASEFONT, TAG_ID.BASEFONT],
        [TAG_NAMES.BGSOUND, TAG_ID.BGSOUND],
        [TAG_NAMES.BIG, TAG_ID.BIG],
        [TAG_NAMES.BLOCKQUOTE, TAG_ID.BLOCKQUOTE],
        [TAG_NAMES.BODY, TAG_ID.BODY],
        [TAG_NAMES.BR, TAG_ID.BR],
        [TAG_NAMES.BUTTON, TAG_ID.BUTTON],
        [TAG_NAMES.CAPTION, TAG_ID.CAPTION],
        [TAG_NAMES.CENTER, TAG_ID.CENTER],
        [TAG_NAMES.CODE, TAG_ID.CODE],
        [TAG_NAMES.COL, TAG_ID.COL],
        [TAG_NAMES.COLGROUP, TAG_ID.COLGROUP],
        [TAG_NAMES.DD, TAG_ID.DD],
        [TAG_NAMES.DESC, TAG_ID.DESC],
        [TAG_NAMES.DETAILS, TAG_ID.DETAILS],
        [TAG_NAMES.DIALOG, TAG_ID.DIALOG],
        [TAG_NAMES.DIR, TAG_ID.DIR],
        [TAG_NAMES.DIV, TAG_ID.DIV],
        [TAG_NAMES.DL, TAG_ID.DL],
        [TAG_NAMES.DT, TAG_ID.DT],
        [TAG_NAMES.EM, TAG_ID.EM],
        [TAG_NAMES.EMBED, TAG_ID.EMBED],
        [TAG_NAMES.FIELDSET, TAG_ID.FIELDSET],
        [TAG_NAMES.FIGCAPTION, TAG_ID.FIGCAPTION],
        [TAG_NAMES.FIGURE, TAG_ID.FIGURE],
        [TAG_NAMES.FONT, TAG_ID.FONT],
        [TAG_NAMES.FOOTER, TAG_ID.FOOTER],
        [TAG_NAMES.FOREIGN_OBJECT, TAG_ID.FOREIGN_OBJECT],
        [TAG_NAMES.FORM, TAG_ID.FORM],
        [TAG_NAMES.FRAME, TAG_ID.FRAME],
        [TAG_NAMES.FRAMESET, TAG_ID.FRAMESET],
        [TAG_NAMES.H1, TAG_ID.H1],
        [TAG_NAMES.H2, TAG_ID.H2],
        [TAG_NAMES.H3, TAG_ID.H3],
        [TAG_NAMES.H4, TAG_ID.H4],
        [TAG_NAMES.H5, TAG_ID.H5],
        [TAG_NAMES.H6, TAG_ID.H6],
        [TAG_NAMES.HEAD, TAG_ID.HEAD],
        [TAG_NAMES.HEADER, TAG_ID.HEADER],
        [TAG_NAMES.HGROUP, TAG_ID.HGROUP],
        [TAG_NAMES.HR, TAG_ID.HR],
        [TAG_NAMES.HTML, TAG_ID.HTML],
        [TAG_NAMES.I, TAG_ID.I],
        [TAG_NAMES.IMG, TAG_ID.IMG],
        [TAG_NAMES.IMAGE, TAG_ID.IMAGE],
        [TAG_NAMES.INPUT, TAG_ID.INPUT],
        [TAG_NAMES.IFRAME, TAG_ID.IFRAME],
        [TAG_NAMES.KEYGEN, TAG_ID.KEYGEN],
        [TAG_NAMES.LABEL, TAG_ID.LABEL],
        [TAG_NAMES.LI, TAG_ID.LI],
        [TAG_NAMES.LINK, TAG_ID.LINK],
        [TAG_NAMES.LISTING, TAG_ID.LISTING],
        [TAG_NAMES.MAIN, TAG_ID.MAIN],
        [TAG_NAMES.MALIGNMARK, TAG_ID.MALIGNMARK],
        [TAG_NAMES.MARQUEE, TAG_ID.MARQUEE],
        [TAG_NAMES.MATH, TAG_ID.MATH],
        [TAG_NAMES.MENU, TAG_ID.MENU],
        [TAG_NAMES.META, TAG_ID.META],
        [TAG_NAMES.MGLYPH, TAG_ID.MGLYPH],
        [TAG_NAMES.MI, TAG_ID.MI],
        [TAG_NAMES.MO, TAG_ID.MO],
        [TAG_NAMES.MN, TAG_ID.MN],
        [TAG_NAMES.MS, TAG_ID.MS],
        [TAG_NAMES.MTEXT, TAG_ID.MTEXT],
        [TAG_NAMES.NAV, TAG_ID.NAV],
        [TAG_NAMES.NOBR, TAG_ID.NOBR],
        [TAG_NAMES.NOFRAMES, TAG_ID.NOFRAMES],
        [TAG_NAMES.NOEMBED, TAG_ID.NOEMBED],
        [TAG_NAMES.NOSCRIPT, TAG_ID.NOSCRIPT],
        [TAG_NAMES.OBJECT, TAG_ID.OBJECT],
        [TAG_NAMES.OL, TAG_ID.OL],
        [TAG_NAMES.OPTGROUP, TAG_ID.OPTGROUP],
        [TAG_NAMES.OPTION, TAG_ID.OPTION],
        [TAG_NAMES.P, TAG_ID.P],
        [TAG_NAMES.PARAM, TAG_ID.PARAM],
        [TAG_NAMES.PLAINTEXT, TAG_ID.PLAINTEXT],
        [TAG_NAMES.PRE, TAG_ID.PRE],
        [TAG_NAMES.RB, TAG_ID.RB],
        [TAG_NAMES.RP, TAG_ID.RP],
        [TAG_NAMES.RT, TAG_ID.RT],
        [TAG_NAMES.RTC, TAG_ID.RTC],
        [TAG_NAMES.RUBY, TAG_ID.RUBY],
        [TAG_NAMES.S, TAG_ID.S],
        [TAG_NAMES.SCRIPT, TAG_ID.SCRIPT],
        [TAG_NAMES.SECTION, TAG_ID.SECTION],
        [TAG_NAMES.SELECT, TAG_ID.SELECT],
        [TAG_NAMES.SOURCE, TAG_ID.SOURCE],
        [TAG_NAMES.SMALL, TAG_ID.SMALL],
        [TAG_NAMES.SPAN, TAG_ID.SPAN],
        [TAG_NAMES.STRIKE, TAG_ID.STRIKE],
        [TAG_NAMES.STRONG, TAG_ID.STRONG],
        [TAG_NAMES.STYLE, TAG_ID.STYLE],
        [TAG_NAMES.SUB, TAG_ID.SUB],
        [TAG_NAMES.SUMMARY, TAG_ID.SUMMARY],
        [TAG_NAMES.SUP, TAG_ID.SUP],
        [TAG_NAMES.TABLE, TAG_ID.TABLE],
        [TAG_NAMES.TBODY, TAG_ID.TBODY],
        [TAG_NAMES.TEMPLATE, TAG_ID.TEMPLATE],
        [TAG_NAMES.TEXTAREA, TAG_ID.TEXTAREA],
        [TAG_NAMES.TFOOT, TAG_ID.TFOOT],
        [TAG_NAMES.TD, TAG_ID.TD],
        [TAG_NAMES.TH, TAG_ID.TH],
        [TAG_NAMES.THEAD, TAG_ID.THEAD],
        [TAG_NAMES.TITLE, TAG_ID.TITLE],
        [TAG_NAMES.TR, TAG_ID.TR],
        [TAG_NAMES.TRACK, TAG_ID.TRACK],
        [TAG_NAMES.TT, TAG_ID.TT],
        [TAG_NAMES.U, TAG_ID.U],
        [TAG_NAMES.UL, TAG_ID.UL],
        [TAG_NAMES.SVG, TAG_ID.SVG],
        [TAG_NAMES.VAR, TAG_ID.VAR],
        [TAG_NAMES.WBR, TAG_ID.WBR],
        [TAG_NAMES.XMP, TAG_ID.XMP],
    ]);
    function getTagID(tagName) {
        var _a;
        return (_a = TAG_NAME_TO_ID.get(tagName)) !== null && _a !== void 0 ? _a : TAG_ID.UNKNOWN;
    }
    const $ = TAG_ID;
    const SPECIAL_ELEMENTS = {
        [NS.HTML]: new Set([
            $.ADDRESS,
            $.APPLET,
            $.AREA,
            $.ARTICLE,
            $.ASIDE,
            $.BASE,
            $.BASEFONT,
            $.BGSOUND,
            $.BLOCKQUOTE,
            $.BODY,
            $.BR,
            $.BUTTON,
            $.CAPTION,
            $.CENTER,
            $.COL,
            $.COLGROUP,
            $.DD,
            $.DETAILS,
            $.DIR,
            $.DIV,
            $.DL,
            $.DT,
            $.EMBED,
            $.FIELDSET,
            $.FIGCAPTION,
            $.FIGURE,
            $.FOOTER,
            $.FORM,
            $.FRAME,
            $.FRAMESET,
            $.H1,
            $.H2,
            $.H3,
            $.H4,
            $.H5,
            $.H6,
            $.HEAD,
            $.HEADER,
            $.HGROUP,
            $.HR,
            $.HTML,
            $.IFRAME,
            $.IMG,
            $.INPUT,
            $.LI,
            $.LINK,
            $.LISTING,
            $.MAIN,
            $.MARQUEE,
            $.MENU,
            $.META,
            $.NAV,
            $.NOEMBED,
            $.NOFRAMES,
            $.NOSCRIPT,
            $.OBJECT,
            $.OL,
            $.P,
            $.PARAM,
            $.PLAINTEXT,
            $.PRE,
            $.SCRIPT,
            $.SECTION,
            $.SELECT,
            $.SOURCE,
            $.STYLE,
            $.SUMMARY,
            $.TABLE,
            $.TBODY,
            $.TD,
            $.TEMPLATE,
            $.TEXTAREA,
            $.TFOOT,
            $.TH,
            $.THEAD,
            $.TITLE,
            $.TR,
            $.TRACK,
            $.UL,
            $.WBR,
            $.XMP,
        ]),
        [NS.MATHML]: new Set([$.MI, $.MO, $.MN, $.MS, $.MTEXT, $.ANNOTATION_XML]),
        [NS.SVG]: new Set([$.TITLE, $.FOREIGN_OBJECT, $.DESC]),
        [NS.XLINK]: new Set(),
        [NS.XML]: new Set(),
        [NS.XMLNS]: new Set(),
    };
    function isNumberedHeader(tn) {
        return tn === $.H1 || tn === $.H2 || tn === $.H3 || tn === $.H4 || tn === $.H5 || tn === $.H6;
    }
    const UNESCAPED_TEXT = new Set([
        TAG_NAMES.STYLE,
        TAG_NAMES.SCRIPT,
        TAG_NAMES.XMP,
        TAG_NAMES.IFRAME,
        TAG_NAMES.NOEMBED,
        TAG_NAMES.NOFRAMES,
        TAG_NAMES.PLAINTEXT,
    ]);
    function hasUnescapedText(tn, scriptingEnabled) {
        return UNESCAPED_TEXT.has(tn) || (scriptingEnabled && tn === TAG_NAMES.NOSCRIPT);
    }

    //C1 Unicode control character reference replacements
    const C1_CONTROLS_REFERENCE_REPLACEMENTS = new Map([
        [0x80, 8364],
        [0x82, 8218],
        [0x83, 402],
        [0x84, 8222],
        [0x85, 8230],
        [0x86, 8224],
        [0x87, 8225],
        [0x88, 710],
        [0x89, 8240],
        [0x8a, 352],
        [0x8b, 8249],
        [0x8c, 338],
        [0x8e, 381],
        [0x91, 8216],
        [0x92, 8217],
        [0x93, 8220],
        [0x94, 8221],
        [0x95, 8226],
        [0x96, 8211],
        [0x97, 8212],
        [0x98, 732],
        [0x99, 8482],
        [0x9a, 353],
        [0x9b, 8250],
        [0x9c, 339],
        [0x9e, 382],
        [0x9f, 376],
    ]);
    //States
    var State$1;
    (function (State) {
        State[State["DATA"] = 0] = "DATA";
        State[State["RCDATA"] = 1] = "RCDATA";
        State[State["RAWTEXT"] = 2] = "RAWTEXT";
        State[State["SCRIPT_DATA"] = 3] = "SCRIPT_DATA";
        State[State["PLAINTEXT"] = 4] = "PLAINTEXT";
        State[State["TAG_OPEN"] = 5] = "TAG_OPEN";
        State[State["END_TAG_OPEN"] = 6] = "END_TAG_OPEN";
        State[State["TAG_NAME"] = 7] = "TAG_NAME";
        State[State["RCDATA_LESS_THAN_SIGN"] = 8] = "RCDATA_LESS_THAN_SIGN";
        State[State["RCDATA_END_TAG_OPEN"] = 9] = "RCDATA_END_TAG_OPEN";
        State[State["RCDATA_END_TAG_NAME"] = 10] = "RCDATA_END_TAG_NAME";
        State[State["RAWTEXT_LESS_THAN_SIGN"] = 11] = "RAWTEXT_LESS_THAN_SIGN";
        State[State["RAWTEXT_END_TAG_OPEN"] = 12] = "RAWTEXT_END_TAG_OPEN";
        State[State["RAWTEXT_END_TAG_NAME"] = 13] = "RAWTEXT_END_TAG_NAME";
        State[State["SCRIPT_DATA_LESS_THAN_SIGN"] = 14] = "SCRIPT_DATA_LESS_THAN_SIGN";
        State[State["SCRIPT_DATA_END_TAG_OPEN"] = 15] = "SCRIPT_DATA_END_TAG_OPEN";
        State[State["SCRIPT_DATA_END_TAG_NAME"] = 16] = "SCRIPT_DATA_END_TAG_NAME";
        State[State["SCRIPT_DATA_ESCAPE_START"] = 17] = "SCRIPT_DATA_ESCAPE_START";
        State[State["SCRIPT_DATA_ESCAPE_START_DASH"] = 18] = "SCRIPT_DATA_ESCAPE_START_DASH";
        State[State["SCRIPT_DATA_ESCAPED"] = 19] = "SCRIPT_DATA_ESCAPED";
        State[State["SCRIPT_DATA_ESCAPED_DASH"] = 20] = "SCRIPT_DATA_ESCAPED_DASH";
        State[State["SCRIPT_DATA_ESCAPED_DASH_DASH"] = 21] = "SCRIPT_DATA_ESCAPED_DASH_DASH";
        State[State["SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN"] = 22] = "SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN";
        State[State["SCRIPT_DATA_ESCAPED_END_TAG_OPEN"] = 23] = "SCRIPT_DATA_ESCAPED_END_TAG_OPEN";
        State[State["SCRIPT_DATA_ESCAPED_END_TAG_NAME"] = 24] = "SCRIPT_DATA_ESCAPED_END_TAG_NAME";
        State[State["SCRIPT_DATA_DOUBLE_ESCAPE_START"] = 25] = "SCRIPT_DATA_DOUBLE_ESCAPE_START";
        State[State["SCRIPT_DATA_DOUBLE_ESCAPED"] = 26] = "SCRIPT_DATA_DOUBLE_ESCAPED";
        State[State["SCRIPT_DATA_DOUBLE_ESCAPED_DASH"] = 27] = "SCRIPT_DATA_DOUBLE_ESCAPED_DASH";
        State[State["SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH"] = 28] = "SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH";
        State[State["SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN"] = 29] = "SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN";
        State[State["SCRIPT_DATA_DOUBLE_ESCAPE_END"] = 30] = "SCRIPT_DATA_DOUBLE_ESCAPE_END";
        State[State["BEFORE_ATTRIBUTE_NAME"] = 31] = "BEFORE_ATTRIBUTE_NAME";
        State[State["ATTRIBUTE_NAME"] = 32] = "ATTRIBUTE_NAME";
        State[State["AFTER_ATTRIBUTE_NAME"] = 33] = "AFTER_ATTRIBUTE_NAME";
        State[State["BEFORE_ATTRIBUTE_VALUE"] = 34] = "BEFORE_ATTRIBUTE_VALUE";
        State[State["ATTRIBUTE_VALUE_DOUBLE_QUOTED"] = 35] = "ATTRIBUTE_VALUE_DOUBLE_QUOTED";
        State[State["ATTRIBUTE_VALUE_SINGLE_QUOTED"] = 36] = "ATTRIBUTE_VALUE_SINGLE_QUOTED";
        State[State["ATTRIBUTE_VALUE_UNQUOTED"] = 37] = "ATTRIBUTE_VALUE_UNQUOTED";
        State[State["AFTER_ATTRIBUTE_VALUE_QUOTED"] = 38] = "AFTER_ATTRIBUTE_VALUE_QUOTED";
        State[State["SELF_CLOSING_START_TAG"] = 39] = "SELF_CLOSING_START_TAG";
        State[State["BOGUS_COMMENT"] = 40] = "BOGUS_COMMENT";
        State[State["MARKUP_DECLARATION_OPEN"] = 41] = "MARKUP_DECLARATION_OPEN";
        State[State["COMMENT_START"] = 42] = "COMMENT_START";
        State[State["COMMENT_START_DASH"] = 43] = "COMMENT_START_DASH";
        State[State["COMMENT"] = 44] = "COMMENT";
        State[State["COMMENT_LESS_THAN_SIGN"] = 45] = "COMMENT_LESS_THAN_SIGN";
        State[State["COMMENT_LESS_THAN_SIGN_BANG"] = 46] = "COMMENT_LESS_THAN_SIGN_BANG";
        State[State["COMMENT_LESS_THAN_SIGN_BANG_DASH"] = 47] = "COMMENT_LESS_THAN_SIGN_BANG_DASH";
        State[State["COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH"] = 48] = "COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH";
        State[State["COMMENT_END_DASH"] = 49] = "COMMENT_END_DASH";
        State[State["COMMENT_END"] = 50] = "COMMENT_END";
        State[State["COMMENT_END_BANG"] = 51] = "COMMENT_END_BANG";
        State[State["DOCTYPE"] = 52] = "DOCTYPE";
        State[State["BEFORE_DOCTYPE_NAME"] = 53] = "BEFORE_DOCTYPE_NAME";
        State[State["DOCTYPE_NAME"] = 54] = "DOCTYPE_NAME";
        State[State["AFTER_DOCTYPE_NAME"] = 55] = "AFTER_DOCTYPE_NAME";
        State[State["AFTER_DOCTYPE_PUBLIC_KEYWORD"] = 56] = "AFTER_DOCTYPE_PUBLIC_KEYWORD";
        State[State["BEFORE_DOCTYPE_PUBLIC_IDENTIFIER"] = 57] = "BEFORE_DOCTYPE_PUBLIC_IDENTIFIER";
        State[State["DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED"] = 58] = "DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED";
        State[State["DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED"] = 59] = "DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED";
        State[State["AFTER_DOCTYPE_PUBLIC_IDENTIFIER"] = 60] = "AFTER_DOCTYPE_PUBLIC_IDENTIFIER";
        State[State["BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS"] = 61] = "BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS";
        State[State["AFTER_DOCTYPE_SYSTEM_KEYWORD"] = 62] = "AFTER_DOCTYPE_SYSTEM_KEYWORD";
        State[State["BEFORE_DOCTYPE_SYSTEM_IDENTIFIER"] = 63] = "BEFORE_DOCTYPE_SYSTEM_IDENTIFIER";
        State[State["DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED"] = 64] = "DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED";
        State[State["DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED"] = 65] = "DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED";
        State[State["AFTER_DOCTYPE_SYSTEM_IDENTIFIER"] = 66] = "AFTER_DOCTYPE_SYSTEM_IDENTIFIER";
        State[State["BOGUS_DOCTYPE"] = 67] = "BOGUS_DOCTYPE";
        State[State["CDATA_SECTION"] = 68] = "CDATA_SECTION";
        State[State["CDATA_SECTION_BRACKET"] = 69] = "CDATA_SECTION_BRACKET";
        State[State["CDATA_SECTION_END"] = 70] = "CDATA_SECTION_END";
        State[State["CHARACTER_REFERENCE"] = 71] = "CHARACTER_REFERENCE";
        State[State["NAMED_CHARACTER_REFERENCE"] = 72] = "NAMED_CHARACTER_REFERENCE";
        State[State["AMBIGUOUS_AMPERSAND"] = 73] = "AMBIGUOUS_AMPERSAND";
        State[State["NUMERIC_CHARACTER_REFERENCE"] = 74] = "NUMERIC_CHARACTER_REFERENCE";
        State[State["HEXADEMICAL_CHARACTER_REFERENCE_START"] = 75] = "HEXADEMICAL_CHARACTER_REFERENCE_START";
        State[State["DECIMAL_CHARACTER_REFERENCE_START"] = 76] = "DECIMAL_CHARACTER_REFERENCE_START";
        State[State["HEXADEMICAL_CHARACTER_REFERENCE"] = 77] = "HEXADEMICAL_CHARACTER_REFERENCE";
        State[State["DECIMAL_CHARACTER_REFERENCE"] = 78] = "DECIMAL_CHARACTER_REFERENCE";
        State[State["NUMERIC_CHARACTER_REFERENCE_END"] = 79] = "NUMERIC_CHARACTER_REFERENCE_END";
    })(State$1 || (State$1 = {}));
    //Tokenizer initial states for different modes
    const TokenizerMode = {
        DATA: State$1.DATA,
        RCDATA: State$1.RCDATA,
        RAWTEXT: State$1.RAWTEXT,
        SCRIPT_DATA: State$1.SCRIPT_DATA,
        PLAINTEXT: State$1.PLAINTEXT,
        CDATA_SECTION: State$1.CDATA_SECTION,
    };
    //Utils
    //OPTIMIZATION: these utility functions should not be moved out of this module. V8 Crankshaft will not inline
    //this functions if they will be situated in another module due to context switch.
    //Always perform inlining check before modifying this functions ('node --trace-inlining').
    function isAsciiDigit(cp) {
        return cp >= CODE_POINTS.DIGIT_0 && cp <= CODE_POINTS.DIGIT_9;
    }
    function isAsciiUpper(cp) {
        return cp >= CODE_POINTS.LATIN_CAPITAL_A && cp <= CODE_POINTS.LATIN_CAPITAL_Z;
    }
    function isAsciiLower(cp) {
        return cp >= CODE_POINTS.LATIN_SMALL_A && cp <= CODE_POINTS.LATIN_SMALL_Z;
    }
    function isAsciiLetter(cp) {
        return isAsciiLower(cp) || isAsciiUpper(cp);
    }
    function isAsciiAlphaNumeric(cp) {
        return isAsciiLetter(cp) || isAsciiDigit(cp);
    }
    function isAsciiUpperHexDigit(cp) {
        return cp >= CODE_POINTS.LATIN_CAPITAL_A && cp <= CODE_POINTS.LATIN_CAPITAL_F;
    }
    function isAsciiLowerHexDigit(cp) {
        return cp >= CODE_POINTS.LATIN_SMALL_A && cp <= CODE_POINTS.LATIN_SMALL_F;
    }
    function isAsciiHexDigit(cp) {
        return isAsciiDigit(cp) || isAsciiUpperHexDigit(cp) || isAsciiLowerHexDigit(cp);
    }
    function toAsciiLower(cp) {
        return cp + 32;
    }
    function isWhitespace$1(cp) {
        return cp === CODE_POINTS.SPACE || cp === CODE_POINTS.LINE_FEED || cp === CODE_POINTS.TABULATION || cp === CODE_POINTS.FORM_FEED;
    }
    function isEntityInAttributeInvalidEnd(nextCp) {
        return nextCp === CODE_POINTS.EQUALS_SIGN || isAsciiAlphaNumeric(nextCp);
    }
    function isScriptDataDoubleEscapeSequenceEnd(cp) {
        return isWhitespace$1(cp) || cp === CODE_POINTS.SOLIDUS || cp === CODE_POINTS.GREATER_THAN_SIGN;
    }
    //Tokenizer
    class Tokenizer$1 {
        constructor(options, handler) {
            this.options = options;
            this.handler = handler;
            this.paused = false;
            /** Ensures that the parsing loop isn't run multiple times at once. */
            this.inLoop = false;
            /**
             * Indicates that the current adjusted node exists, is not an element in the HTML namespace,
             * and that it is not an integration point for either MathML or HTML.
             *
             * @see {@link https://html.spec.whatwg.org/multipage/parsing.html#tree-construction}
             */
            this.inForeignNode = false;
            this.lastStartTagName = '';
            this.active = false;
            this.state = State$1.DATA;
            this.returnState = State$1.DATA;
            this.charRefCode = -1;
            this.consumedAfterSnapshot = -1;
            this.currentCharacterToken = null;
            this.currentToken = null;
            this.currentAttr = { name: '', value: '' };
            this.preprocessor = new Preprocessor(handler);
            this.currentLocation = this.getCurrentLocation(-1);
        }
        //Errors
        _err(code) {
            var _a, _b;
            (_b = (_a = this.handler).onParseError) === null || _b === void 0 ? void 0 : _b.call(_a, this.preprocessor.getError(code));
        }
        // NOTE: `offset` may never run across line boundaries.
        getCurrentLocation(offset) {
            if (!this.options.sourceCodeLocationInfo) {
                return null;
            }
            return {
                startLine: this.preprocessor.line,
                startCol: this.preprocessor.col - offset,
                startOffset: this.preprocessor.offset - offset,
                endLine: -1,
                endCol: -1,
                endOffset: -1,
            };
        }
        _runParsingLoop() {
            if (this.inLoop)
                return;
            this.inLoop = true;
            while (this.active && !this.paused) {
                this.consumedAfterSnapshot = 0;
                const cp = this._consume();
                if (!this._ensureHibernation()) {
                    this._callState(cp);
                }
            }
            this.inLoop = false;
        }
        //API
        pause() {
            this.paused = true;
        }
        resume(writeCallback) {
            if (!this.paused) {
                throw new Error('Parser was already resumed');
            }
            this.paused = false;
            // Necessary for synchronous resume.
            if (this.inLoop)
                return;
            this._runParsingLoop();
            if (!this.paused) {
                writeCallback === null || writeCallback === void 0 ? void 0 : writeCallback();
            }
        }
        write(chunk, isLastChunk, writeCallback) {
            this.active = true;
            this.preprocessor.write(chunk, isLastChunk);
            this._runParsingLoop();
            if (!this.paused) {
                writeCallback === null || writeCallback === void 0 ? void 0 : writeCallback();
            }
        }
        insertHtmlAtCurrentPos(chunk) {
            this.active = true;
            this.preprocessor.insertHtmlAtCurrentPos(chunk);
            this._runParsingLoop();
        }
        //Hibernation
        _ensureHibernation() {
            if (this.preprocessor.endOfChunkHit) {
                this._unconsume(this.consumedAfterSnapshot);
                this.active = false;
                return true;
            }
            return false;
        }
        //Consumption
        _consume() {
            this.consumedAfterSnapshot++;
            return this.preprocessor.advance();
        }
        _unconsume(count) {
            this.consumedAfterSnapshot -= count;
            this.preprocessor.retreat(count);
        }
        _reconsumeInState(state) {
            this.state = state;
            this._unconsume(1);
        }
        _advanceBy(count) {
            this.consumedAfterSnapshot += count;
            for (let i = 0; i < count; i++) {
                this.preprocessor.advance();
            }
        }
        _consumeSequenceIfMatch(pattern, caseSensitive) {
            if (this.preprocessor.startsWith(pattern, caseSensitive)) {
                // We will already have consumed one character before calling this method.
                this._advanceBy(pattern.length - 1);
                return true;
            }
            return false;
        }
        //Token creation
        _createStartTagToken() {
            this.currentToken = {
                type: TokenType.START_TAG,
                tagName: '',
                tagID: TAG_ID.UNKNOWN,
                selfClosing: false,
                ackSelfClosing: false,
                attrs: [],
                location: this.getCurrentLocation(1),
            };
        }
        _createEndTagToken() {
            this.currentToken = {
                type: TokenType.END_TAG,
                tagName: '',
                tagID: TAG_ID.UNKNOWN,
                selfClosing: false,
                ackSelfClosing: false,
                attrs: [],
                location: this.getCurrentLocation(2),
            };
        }
        _createCommentToken(offset) {
            this.currentToken = {
                type: TokenType.COMMENT,
                data: '',
                location: this.getCurrentLocation(offset),
            };
        }
        _createDoctypeToken(initialName) {
            this.currentToken = {
                type: TokenType.DOCTYPE,
                name: initialName,
                forceQuirks: false,
                publicId: null,
                systemId: null,
                location: this.currentLocation,
            };
        }
        _createCharacterToken(type, chars) {
            this.currentCharacterToken = {
                type,
                chars,
                location: this.currentLocation,
            };
        }
        //Tag attributes
        _createAttr(attrNameFirstCh) {
            this.currentAttr = {
                name: attrNameFirstCh,
                value: '',
            };
            this.currentLocation = this.getCurrentLocation(0);
        }
        _leaveAttrName() {
            var _a;
            var _b;
            const token = this.currentToken;
            if (getTokenAttr(token, this.currentAttr.name) === null) {
                token.attrs.push(this.currentAttr);
                if (token.location && this.currentLocation) {
                    const attrLocations = ((_a = (_b = token.location).attrs) !== null && _a !== void 0 ? _a : (_b.attrs = Object.create(null)));
                    attrLocations[this.currentAttr.name] = this.currentLocation;
                    // Set end location
                    this._leaveAttrValue();
                }
            }
            else {
                this._err(ERR.duplicateAttribute);
            }
        }
        _leaveAttrValue() {
            if (this.currentLocation) {
                this.currentLocation.endLine = this.preprocessor.line;
                this.currentLocation.endCol = this.preprocessor.col;
                this.currentLocation.endOffset = this.preprocessor.offset;
            }
        }
        //Token emission
        prepareToken(ct) {
            this._emitCurrentCharacterToken(ct.location);
            this.currentToken = null;
            if (ct.location) {
                ct.location.endLine = this.preprocessor.line;
                ct.location.endCol = this.preprocessor.col + 1;
                ct.location.endOffset = this.preprocessor.offset + 1;
            }
            this.currentLocation = this.getCurrentLocation(-1);
        }
        emitCurrentTagToken() {
            const ct = this.currentToken;
            this.prepareToken(ct);
            ct.tagID = getTagID(ct.tagName);
            if (ct.type === TokenType.START_TAG) {
                this.lastStartTagName = ct.tagName;
                this.handler.onStartTag(ct);
            }
            else {
                if (ct.attrs.length > 0) {
                    this._err(ERR.endTagWithAttributes);
                }
                if (ct.selfClosing) {
                    this._err(ERR.endTagWithTrailingSolidus);
                }
                this.handler.onEndTag(ct);
            }
            this.preprocessor.dropParsedChunk();
        }
        emitCurrentComment(ct) {
            this.prepareToken(ct);
            this.handler.onComment(ct);
            this.preprocessor.dropParsedChunk();
        }
        emitCurrentDoctype(ct) {
            this.prepareToken(ct);
            this.handler.onDoctype(ct);
            this.preprocessor.dropParsedChunk();
        }
        _emitCurrentCharacterToken(nextLocation) {
            if (this.currentCharacterToken) {
                //NOTE: if we have a pending character token, make it's end location equal to the
                //current token's start location.
                if (nextLocation && this.currentCharacterToken.location) {
                    this.currentCharacterToken.location.endLine = nextLocation.startLine;
                    this.currentCharacterToken.location.endCol = nextLocation.startCol;
                    this.currentCharacterToken.location.endOffset = nextLocation.startOffset;
                }
                switch (this.currentCharacterToken.type) {
                    case TokenType.CHARACTER: {
                        this.handler.onCharacter(this.currentCharacterToken);
                        break;
                    }
                    case TokenType.NULL_CHARACTER: {
                        this.handler.onNullCharacter(this.currentCharacterToken);
                        break;
                    }
                    case TokenType.WHITESPACE_CHARACTER: {
                        this.handler.onWhitespaceCharacter(this.currentCharacterToken);
                        break;
                    }
                }
                this.currentCharacterToken = null;
            }
        }
        _emitEOFToken() {
            const location = this.getCurrentLocation(0);
            if (location) {
                location.endLine = location.startLine;
                location.endCol = location.startCol;
                location.endOffset = location.startOffset;
            }
            this._emitCurrentCharacterToken(location);
            this.handler.onEof({ type: TokenType.EOF, location });
            this.active = false;
        }
        //Characters emission
        //OPTIMIZATION: specification uses only one type of character tokens (one token per character).
        //This causes a huge memory overhead and a lot of unnecessary parser loops. parse5 uses 3 groups of characters.
        //If we have a sequence of characters that belong to the same group, the parser can process it
        //as a single solid character token.
        //So, there are 3 types of character tokens in parse5:
        //1)TokenType.NULL_CHARACTER - \u0000-character sequences (e.g. '\u0000\u0000\u0000')
        //2)TokenType.WHITESPACE_CHARACTER - any whitespace/new-line character sequences (e.g. '\n  \r\t   \f')
        //3)TokenType.CHARACTER - any character sequence which don't belong to groups 1 and 2 (e.g. 'abcdef1234@@#$%^')
        _appendCharToCurrentCharacterToken(type, ch) {
            if (this.currentCharacterToken) {
                if (this.currentCharacterToken.type !== type) {
                    this.currentLocation = this.getCurrentLocation(0);
                    this._emitCurrentCharacterToken(this.currentLocation);
                    this.preprocessor.dropParsedChunk();
                }
                else {
                    this.currentCharacterToken.chars += ch;
                    return;
                }
            }
            this._createCharacterToken(type, ch);
        }
        _emitCodePoint(cp) {
            let type = TokenType.CHARACTER;
            if (isWhitespace$1(cp)) {
                type = TokenType.WHITESPACE_CHARACTER;
            }
            else if (cp === CODE_POINTS.NULL) {
                type = TokenType.NULL_CHARACTER;
            }
            this._appendCharToCurrentCharacterToken(type, String.fromCodePoint(cp));
        }
        //NOTE: used when we emit characters explicitly.
        //This is always for non-whitespace and non-null characters, which allows us to avoid additional checks.
        _emitChars(ch) {
            this._appendCharToCurrentCharacterToken(TokenType.CHARACTER, ch);
        }
        // Character reference helpers
        _matchNamedCharacterReference(cp) {
            let result = null;
            let excess = 0;
            let withoutSemicolon = false;
            for (let i = 0, current = htmlDecodeTree[0]; i >= 0; cp = this._consume()) {
                i = determineBranch(htmlDecodeTree, current, i + 1, cp);
                if (i < 0)
                    break;
                excess += 1;
                current = htmlDecodeTree[i];
                const masked = current & BinTrieFlags.VALUE_LENGTH;
                // If the branch is a value, store it and continue
                if (masked) {
                    // The mask is the number of bytes of the value, including the current byte.
                    const valueLength = (masked >> 14) - 1;
                    // Attribute values that aren't terminated properly aren't parsed, and shouldn't lead to a parser error.
                    // See the example in https://html.spec.whatwg.org/multipage/parsing.html#named-character-reference-state
                    if (cp !== CODE_POINTS.SEMICOLON &&
                        this._isCharacterReferenceInAttribute() &&
                        isEntityInAttributeInvalidEnd(this.preprocessor.peek(1))) {
                        //NOTE: we don't flush all consumed code points here, and instead switch back to the original state after
                        //emitting an ampersand. This is fine, as alphanumeric characters won't be parsed differently in attributes.
                        result = [CODE_POINTS.AMPERSAND];
                        // Skip over the value.
                        i += valueLength;
                    }
                    else {
                        // If this is a surrogate pair, consume the next two bytes.
                        result =
                            valueLength === 0
                                ? [htmlDecodeTree[i] & ~BinTrieFlags.VALUE_LENGTH]
                                : valueLength === 1
                                    ? [htmlDecodeTree[++i]]
                                    : [htmlDecodeTree[++i], htmlDecodeTree[++i]];
                        excess = 0;
                        withoutSemicolon = cp !== CODE_POINTS.SEMICOLON;
                    }
                    if (valueLength === 0) {
                        // If the value is zero-length, we're done.
                        this._consume();
                        break;
                    }
                }
            }
            this._unconsume(excess);
            if (withoutSemicolon && !this.preprocessor.endOfChunkHit) {
                this._err(ERR.missingSemicolonAfterCharacterReference);
            }
            // We want to emit the error above on the code point after the entity.
            // We always consume one code point too many in the loop, and we wait to
            // unconsume it until after the error is emitted.
            this._unconsume(1);
            return result;
        }
        _isCharacterReferenceInAttribute() {
            return (this.returnState === State$1.ATTRIBUTE_VALUE_DOUBLE_QUOTED ||
                this.returnState === State$1.ATTRIBUTE_VALUE_SINGLE_QUOTED ||
                this.returnState === State$1.ATTRIBUTE_VALUE_UNQUOTED);
        }
        _flushCodePointConsumedAsCharacterReference(cp) {
            if (this._isCharacterReferenceInAttribute()) {
                this.currentAttr.value += String.fromCodePoint(cp);
            }
            else {
                this._emitCodePoint(cp);
            }
        }
        // Calling states this way turns out to be much faster than any other approach.
        _callState(cp) {
            switch (this.state) {
                case State$1.DATA: {
                    this._stateData(cp);
                    break;
                }
                case State$1.RCDATA: {
                    this._stateRcdata(cp);
                    break;
                }
                case State$1.RAWTEXT: {
                    this._stateRawtext(cp);
                    break;
                }
                case State$1.SCRIPT_DATA: {
                    this._stateScriptData(cp);
                    break;
                }
                case State$1.PLAINTEXT: {
                    this._statePlaintext(cp);
                    break;
                }
                case State$1.TAG_OPEN: {
                    this._stateTagOpen(cp);
                    break;
                }
                case State$1.END_TAG_OPEN: {
                    this._stateEndTagOpen(cp);
                    break;
                }
                case State$1.TAG_NAME: {
                    this._stateTagName(cp);
                    break;
                }
                case State$1.RCDATA_LESS_THAN_SIGN: {
                    this._stateRcdataLessThanSign(cp);
                    break;
                }
                case State$1.RCDATA_END_TAG_OPEN: {
                    this._stateRcdataEndTagOpen(cp);
                    break;
                }
                case State$1.RCDATA_END_TAG_NAME: {
                    this._stateRcdataEndTagName(cp);
                    break;
                }
                case State$1.RAWTEXT_LESS_THAN_SIGN: {
                    this._stateRawtextLessThanSign(cp);
                    break;
                }
                case State$1.RAWTEXT_END_TAG_OPEN: {
                    this._stateRawtextEndTagOpen(cp);
                    break;
                }
                case State$1.RAWTEXT_END_TAG_NAME: {
                    this._stateRawtextEndTagName(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_LESS_THAN_SIGN: {
                    this._stateScriptDataLessThanSign(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_END_TAG_OPEN: {
                    this._stateScriptDataEndTagOpen(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_END_TAG_NAME: {
                    this._stateScriptDataEndTagName(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_ESCAPE_START: {
                    this._stateScriptDataEscapeStart(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_ESCAPE_START_DASH: {
                    this._stateScriptDataEscapeStartDash(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_ESCAPED: {
                    this._stateScriptDataEscaped(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_ESCAPED_DASH: {
                    this._stateScriptDataEscapedDash(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_ESCAPED_DASH_DASH: {
                    this._stateScriptDataEscapedDashDash(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN: {
                    this._stateScriptDataEscapedLessThanSign(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_ESCAPED_END_TAG_OPEN: {
                    this._stateScriptDataEscapedEndTagOpen(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_ESCAPED_END_TAG_NAME: {
                    this._stateScriptDataEscapedEndTagName(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_DOUBLE_ESCAPE_START: {
                    this._stateScriptDataDoubleEscapeStart(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_DOUBLE_ESCAPED: {
                    this._stateScriptDataDoubleEscaped(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_DOUBLE_ESCAPED_DASH: {
                    this._stateScriptDataDoubleEscapedDash(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH: {
                    this._stateScriptDataDoubleEscapedDashDash(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN: {
                    this._stateScriptDataDoubleEscapedLessThanSign(cp);
                    break;
                }
                case State$1.SCRIPT_DATA_DOUBLE_ESCAPE_END: {
                    this._stateScriptDataDoubleEscapeEnd(cp);
                    break;
                }
                case State$1.BEFORE_ATTRIBUTE_NAME: {
                    this._stateBeforeAttributeName(cp);
                    break;
                }
                case State$1.ATTRIBUTE_NAME: {
                    this._stateAttributeName(cp);
                    break;
                }
                case State$1.AFTER_ATTRIBUTE_NAME: {
                    this._stateAfterAttributeName(cp);
                    break;
                }
                case State$1.BEFORE_ATTRIBUTE_VALUE: {
                    this._stateBeforeAttributeValue(cp);
                    break;
                }
                case State$1.ATTRIBUTE_VALUE_DOUBLE_QUOTED: {
                    this._stateAttributeValueDoubleQuoted(cp);
                    break;
                }
                case State$1.ATTRIBUTE_VALUE_SINGLE_QUOTED: {
                    this._stateAttributeValueSingleQuoted(cp);
                    break;
                }
                case State$1.ATTRIBUTE_VALUE_UNQUOTED: {
                    this._stateAttributeValueUnquoted(cp);
                    break;
                }
                case State$1.AFTER_ATTRIBUTE_VALUE_QUOTED: {
                    this._stateAfterAttributeValueQuoted(cp);
                    break;
                }
                case State$1.SELF_CLOSING_START_TAG: {
                    this._stateSelfClosingStartTag(cp);
                    break;
                }
                case State$1.BOGUS_COMMENT: {
                    this._stateBogusComment(cp);
                    break;
                }
                case State$1.MARKUP_DECLARATION_OPEN: {
                    this._stateMarkupDeclarationOpen(cp);
                    break;
                }
                case State$1.COMMENT_START: {
                    this._stateCommentStart(cp);
                    break;
                }
                case State$1.COMMENT_START_DASH: {
                    this._stateCommentStartDash(cp);
                    break;
                }
                case State$1.COMMENT: {
                    this._stateComment(cp);
                    break;
                }
                case State$1.COMMENT_LESS_THAN_SIGN: {
                    this._stateCommentLessThanSign(cp);
                    break;
                }
                case State$1.COMMENT_LESS_THAN_SIGN_BANG: {
                    this._stateCommentLessThanSignBang(cp);
                    break;
                }
                case State$1.COMMENT_LESS_THAN_SIGN_BANG_DASH: {
                    this._stateCommentLessThanSignBangDash(cp);
                    break;
                }
                case State$1.COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH: {
                    this._stateCommentLessThanSignBangDashDash(cp);
                    break;
                }
                case State$1.COMMENT_END_DASH: {
                    this._stateCommentEndDash(cp);
                    break;
                }
                case State$1.COMMENT_END: {
                    this._stateCommentEnd(cp);
                    break;
                }
                case State$1.COMMENT_END_BANG: {
                    this._stateCommentEndBang(cp);
                    break;
                }
                case State$1.DOCTYPE: {
                    this._stateDoctype(cp);
                    break;
                }
                case State$1.BEFORE_DOCTYPE_NAME: {
                    this._stateBeforeDoctypeName(cp);
                    break;
                }
                case State$1.DOCTYPE_NAME: {
                    this._stateDoctypeName(cp);
                    break;
                }
                case State$1.AFTER_DOCTYPE_NAME: {
                    this._stateAfterDoctypeName(cp);
                    break;
                }
                case State$1.AFTER_DOCTYPE_PUBLIC_KEYWORD: {
                    this._stateAfterDoctypePublicKeyword(cp);
                    break;
                }
                case State$1.BEFORE_DOCTYPE_PUBLIC_IDENTIFIER: {
                    this._stateBeforeDoctypePublicIdentifier(cp);
                    break;
                }
                case State$1.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED: {
                    this._stateDoctypePublicIdentifierDoubleQuoted(cp);
                    break;
                }
                case State$1.DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED: {
                    this._stateDoctypePublicIdentifierSingleQuoted(cp);
                    break;
                }
                case State$1.AFTER_DOCTYPE_PUBLIC_IDENTIFIER: {
                    this._stateAfterDoctypePublicIdentifier(cp);
                    break;
                }
                case State$1.BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS: {
                    this._stateBetweenDoctypePublicAndSystemIdentifiers(cp);
                    break;
                }
                case State$1.AFTER_DOCTYPE_SYSTEM_KEYWORD: {
                    this._stateAfterDoctypeSystemKeyword(cp);
                    break;
                }
                case State$1.BEFORE_DOCTYPE_SYSTEM_IDENTIFIER: {
                    this._stateBeforeDoctypeSystemIdentifier(cp);
                    break;
                }
                case State$1.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED: {
                    this._stateDoctypeSystemIdentifierDoubleQuoted(cp);
                    break;
                }
                case State$1.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED: {
                    this._stateDoctypeSystemIdentifierSingleQuoted(cp);
                    break;
                }
                case State$1.AFTER_DOCTYPE_SYSTEM_IDENTIFIER: {
                    this._stateAfterDoctypeSystemIdentifier(cp);
                    break;
                }
                case State$1.BOGUS_DOCTYPE: {
                    this._stateBogusDoctype(cp);
                    break;
                }
                case State$1.CDATA_SECTION: {
                    this._stateCdataSection(cp);
                    break;
                }
                case State$1.CDATA_SECTION_BRACKET: {
                    this._stateCdataSectionBracket(cp);
                    break;
                }
                case State$1.CDATA_SECTION_END: {
                    this._stateCdataSectionEnd(cp);
                    break;
                }
                case State$1.CHARACTER_REFERENCE: {
                    this._stateCharacterReference(cp);
                    break;
                }
                case State$1.NAMED_CHARACTER_REFERENCE: {
                    this._stateNamedCharacterReference(cp);
                    break;
                }
                case State$1.AMBIGUOUS_AMPERSAND: {
                    this._stateAmbiguousAmpersand(cp);
                    break;
                }
                case State$1.NUMERIC_CHARACTER_REFERENCE: {
                    this._stateNumericCharacterReference(cp);
                    break;
                }
                case State$1.HEXADEMICAL_CHARACTER_REFERENCE_START: {
                    this._stateHexademicalCharacterReferenceStart(cp);
                    break;
                }
                case State$1.DECIMAL_CHARACTER_REFERENCE_START: {
                    this._stateDecimalCharacterReferenceStart(cp);
                    break;
                }
                case State$1.HEXADEMICAL_CHARACTER_REFERENCE: {
                    this._stateHexademicalCharacterReference(cp);
                    break;
                }
                case State$1.DECIMAL_CHARACTER_REFERENCE: {
                    this._stateDecimalCharacterReference(cp);
                    break;
                }
                case State$1.NUMERIC_CHARACTER_REFERENCE_END: {
                    this._stateNumericCharacterReferenceEnd();
                    break;
                }
                default: {
                    throw new Error('Unknown state');
                }
            }
        }
        // State machine
        // Data state
        //------------------------------------------------------------------
        _stateData(cp) {
            switch (cp) {
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this.state = State$1.TAG_OPEN;
                    break;
                }
                case CODE_POINTS.AMPERSAND: {
                    this.returnState = State$1.DATA;
                    this.state = State$1.CHARACTER_REFERENCE;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this._emitCodePoint(cp);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._emitCodePoint(cp);
                }
            }
        }
        //  RCDATA state
        //------------------------------------------------------------------
        _stateRcdata(cp) {
            switch (cp) {
                case CODE_POINTS.AMPERSAND: {
                    this.returnState = State$1.RCDATA;
                    this.state = State$1.CHARACTER_REFERENCE;
                    break;
                }
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this.state = State$1.RCDATA_LESS_THAN_SIGN;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this._emitChars(REPLACEMENT_CHARACTER);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._emitCodePoint(cp);
                }
            }
        }
        // RAWTEXT state
        //------------------------------------------------------------------
        _stateRawtext(cp) {
            switch (cp) {
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this.state = State$1.RAWTEXT_LESS_THAN_SIGN;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this._emitChars(REPLACEMENT_CHARACTER);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._emitCodePoint(cp);
                }
            }
        }
        // Script data state
        //------------------------------------------------------------------
        _stateScriptData(cp) {
            switch (cp) {
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this.state = State$1.SCRIPT_DATA_LESS_THAN_SIGN;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this._emitChars(REPLACEMENT_CHARACTER);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._emitCodePoint(cp);
                }
            }
        }
        // PLAINTEXT state
        //------------------------------------------------------------------
        _statePlaintext(cp) {
            switch (cp) {
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this._emitChars(REPLACEMENT_CHARACTER);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._emitCodePoint(cp);
                }
            }
        }
        // Tag open state
        //------------------------------------------------------------------
        _stateTagOpen(cp) {
            if (isAsciiLetter(cp)) {
                this._createStartTagToken();
                this.state = State$1.TAG_NAME;
                this._stateTagName(cp);
            }
            else
                switch (cp) {
                    case CODE_POINTS.EXCLAMATION_MARK: {
                        this.state = State$1.MARKUP_DECLARATION_OPEN;
                        break;
                    }
                    case CODE_POINTS.SOLIDUS: {
                        this.state = State$1.END_TAG_OPEN;
                        break;
                    }
                    case CODE_POINTS.QUESTION_MARK: {
                        this._err(ERR.unexpectedQuestionMarkInsteadOfTagName);
                        this._createCommentToken(1);
                        this.state = State$1.BOGUS_COMMENT;
                        this._stateBogusComment(cp);
                        break;
                    }
                    case CODE_POINTS.EOF: {
                        this._err(ERR.eofBeforeTagName);
                        this._emitChars('<');
                        this._emitEOFToken();
                        break;
                    }
                    default: {
                        this._err(ERR.invalidFirstCharacterOfTagName);
                        this._emitChars('<');
                        this.state = State$1.DATA;
                        this._stateData(cp);
                    }
                }
        }
        // End tag open state
        //------------------------------------------------------------------
        _stateEndTagOpen(cp) {
            if (isAsciiLetter(cp)) {
                this._createEndTagToken();
                this.state = State$1.TAG_NAME;
                this._stateTagName(cp);
            }
            else
                switch (cp) {
                    case CODE_POINTS.GREATER_THAN_SIGN: {
                        this._err(ERR.missingEndTagName);
                        this.state = State$1.DATA;
                        break;
                    }
                    case CODE_POINTS.EOF: {
                        this._err(ERR.eofBeforeTagName);
                        this._emitChars('</');
                        this._emitEOFToken();
                        break;
                    }
                    default: {
                        this._err(ERR.invalidFirstCharacterOfTagName);
                        this._createCommentToken(2);
                        this.state = State$1.BOGUS_COMMENT;
                        this._stateBogusComment(cp);
                    }
                }
        }
        // Tag name state
        //------------------------------------------------------------------
        _stateTagName(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    this.state = State$1.BEFORE_ATTRIBUTE_NAME;
                    break;
                }
                case CODE_POINTS.SOLIDUS: {
                    this.state = State$1.SELF_CLOSING_START_TAG;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.DATA;
                    this.emitCurrentTagToken();
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    token.tagName += REPLACEMENT_CHARACTER;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInTag);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.tagName += String.fromCodePoint(isAsciiUpper(cp) ? toAsciiLower(cp) : cp);
                }
            }
        }
        // RCDATA less-than sign state
        //------------------------------------------------------------------
        _stateRcdataLessThanSign(cp) {
            if (cp === CODE_POINTS.SOLIDUS) {
                this.state = State$1.RCDATA_END_TAG_OPEN;
            }
            else {
                this._emitChars('<');
                this.state = State$1.RCDATA;
                this._stateRcdata(cp);
            }
        }
        // RCDATA end tag open state
        //------------------------------------------------------------------
        _stateRcdataEndTagOpen(cp) {
            if (isAsciiLetter(cp)) {
                this.state = State$1.RCDATA_END_TAG_NAME;
                this._stateRcdataEndTagName(cp);
            }
            else {
                this._emitChars('</');
                this.state = State$1.RCDATA;
                this._stateRcdata(cp);
            }
        }
        handleSpecialEndTag(_cp) {
            if (!this.preprocessor.startsWith(this.lastStartTagName, false)) {
                return !this._ensureHibernation();
            }
            this._createEndTagToken();
            const token = this.currentToken;
            token.tagName = this.lastStartTagName;
            const cp = this.preprocessor.peek(this.lastStartTagName.length);
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    this._advanceBy(this.lastStartTagName.length);
                    this.state = State$1.BEFORE_ATTRIBUTE_NAME;
                    return false;
                }
                case CODE_POINTS.SOLIDUS: {
                    this._advanceBy(this.lastStartTagName.length);
                    this.state = State$1.SELF_CLOSING_START_TAG;
                    return false;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._advanceBy(this.lastStartTagName.length);
                    this.emitCurrentTagToken();
                    this.state = State$1.DATA;
                    return false;
                }
                default: {
                    return !this._ensureHibernation();
                }
            }
        }
        // RCDATA end tag name state
        //------------------------------------------------------------------
        _stateRcdataEndTagName(cp) {
            if (this.handleSpecialEndTag(cp)) {
                this._emitChars('</');
                this.state = State$1.RCDATA;
                this._stateRcdata(cp);
            }
        }
        // RAWTEXT less-than sign state
        //------------------------------------------------------------------
        _stateRawtextLessThanSign(cp) {
            if (cp === CODE_POINTS.SOLIDUS) {
                this.state = State$1.RAWTEXT_END_TAG_OPEN;
            }
            else {
                this._emitChars('<');
                this.state = State$1.RAWTEXT;
                this._stateRawtext(cp);
            }
        }
        // RAWTEXT end tag open state
        //------------------------------------------------------------------
        _stateRawtextEndTagOpen(cp) {
            if (isAsciiLetter(cp)) {
                this.state = State$1.RAWTEXT_END_TAG_NAME;
                this._stateRawtextEndTagName(cp);
            }
            else {
                this._emitChars('</');
                this.state = State$1.RAWTEXT;
                this._stateRawtext(cp);
            }
        }
        // RAWTEXT end tag name state
        //------------------------------------------------------------------
        _stateRawtextEndTagName(cp) {
            if (this.handleSpecialEndTag(cp)) {
                this._emitChars('</');
                this.state = State$1.RAWTEXT;
                this._stateRawtext(cp);
            }
        }
        // Script data less-than sign state
        //------------------------------------------------------------------
        _stateScriptDataLessThanSign(cp) {
            switch (cp) {
                case CODE_POINTS.SOLIDUS: {
                    this.state = State$1.SCRIPT_DATA_END_TAG_OPEN;
                    break;
                }
                case CODE_POINTS.EXCLAMATION_MARK: {
                    this.state = State$1.SCRIPT_DATA_ESCAPE_START;
                    this._emitChars('<!');
                    break;
                }
                default: {
                    this._emitChars('<');
                    this.state = State$1.SCRIPT_DATA;
                    this._stateScriptData(cp);
                }
            }
        }
        // Script data end tag open state
        //------------------------------------------------------------------
        _stateScriptDataEndTagOpen(cp) {
            if (isAsciiLetter(cp)) {
                this.state = State$1.SCRIPT_DATA_END_TAG_NAME;
                this._stateScriptDataEndTagName(cp);
            }
            else {
                this._emitChars('</');
                this.state = State$1.SCRIPT_DATA;
                this._stateScriptData(cp);
            }
        }
        // Script data end tag name state
        //------------------------------------------------------------------
        _stateScriptDataEndTagName(cp) {
            if (this.handleSpecialEndTag(cp)) {
                this._emitChars('</');
                this.state = State$1.SCRIPT_DATA;
                this._stateScriptData(cp);
            }
        }
        // Script data escape start state
        //------------------------------------------------------------------
        _stateScriptDataEscapeStart(cp) {
            if (cp === CODE_POINTS.HYPHEN_MINUS) {
                this.state = State$1.SCRIPT_DATA_ESCAPE_START_DASH;
                this._emitChars('-');
            }
            else {
                this.state = State$1.SCRIPT_DATA;
                this._stateScriptData(cp);
            }
        }
        // Script data escape start dash state
        //------------------------------------------------------------------
        _stateScriptDataEscapeStartDash(cp) {
            if (cp === CODE_POINTS.HYPHEN_MINUS) {
                this.state = State$1.SCRIPT_DATA_ESCAPED_DASH_DASH;
                this._emitChars('-');
            }
            else {
                this.state = State$1.SCRIPT_DATA;
                this._stateScriptData(cp);
            }
        }
        // Script data escaped state
        //------------------------------------------------------------------
        _stateScriptDataEscaped(cp) {
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    this.state = State$1.SCRIPT_DATA_ESCAPED_DASH;
                    this._emitChars('-');
                    break;
                }
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this.state = State$1.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this._emitChars(REPLACEMENT_CHARACTER);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInScriptHtmlCommentLikeText);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._emitCodePoint(cp);
                }
            }
        }
        // Script data escaped dash state
        //------------------------------------------------------------------
        _stateScriptDataEscapedDash(cp) {
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    this.state = State$1.SCRIPT_DATA_ESCAPED_DASH_DASH;
                    this._emitChars('-');
                    break;
                }
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this.state = State$1.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this.state = State$1.SCRIPT_DATA_ESCAPED;
                    this._emitChars(REPLACEMENT_CHARACTER);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInScriptHtmlCommentLikeText);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this.state = State$1.SCRIPT_DATA_ESCAPED;
                    this._emitCodePoint(cp);
                }
            }
        }
        // Script data escaped dash dash state
        //------------------------------------------------------------------
        _stateScriptDataEscapedDashDash(cp) {
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    this._emitChars('-');
                    break;
                }
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this.state = State$1.SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.SCRIPT_DATA;
                    this._emitChars('>');
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this.state = State$1.SCRIPT_DATA_ESCAPED;
                    this._emitChars(REPLACEMENT_CHARACTER);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInScriptHtmlCommentLikeText);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this.state = State$1.SCRIPT_DATA_ESCAPED;
                    this._emitCodePoint(cp);
                }
            }
        }
        // Script data escaped less-than sign state
        //------------------------------------------------------------------
        _stateScriptDataEscapedLessThanSign(cp) {
            if (cp === CODE_POINTS.SOLIDUS) {
                this.state = State$1.SCRIPT_DATA_ESCAPED_END_TAG_OPEN;
            }
            else if (isAsciiLetter(cp)) {
                this._emitChars('<');
                this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPE_START;
                this._stateScriptDataDoubleEscapeStart(cp);
            }
            else {
                this._emitChars('<');
                this.state = State$1.SCRIPT_DATA_ESCAPED;
                this._stateScriptDataEscaped(cp);
            }
        }
        // Script data escaped end tag open state
        //------------------------------------------------------------------
        _stateScriptDataEscapedEndTagOpen(cp) {
            if (isAsciiLetter(cp)) {
                this.state = State$1.SCRIPT_DATA_ESCAPED_END_TAG_NAME;
                this._stateScriptDataEscapedEndTagName(cp);
            }
            else {
                this._emitChars('</');
                this.state = State$1.SCRIPT_DATA_ESCAPED;
                this._stateScriptDataEscaped(cp);
            }
        }
        // Script data escaped end tag name state
        //------------------------------------------------------------------
        _stateScriptDataEscapedEndTagName(cp) {
            if (this.handleSpecialEndTag(cp)) {
                this._emitChars('</');
                this.state = State$1.SCRIPT_DATA_ESCAPED;
                this._stateScriptDataEscaped(cp);
            }
        }
        // Script data double escape start state
        //------------------------------------------------------------------
        _stateScriptDataDoubleEscapeStart(cp) {
            if (this.preprocessor.startsWith(SEQUENCES.SCRIPT, false) &&
                isScriptDataDoubleEscapeSequenceEnd(this.preprocessor.peek(SEQUENCES.SCRIPT.length))) {
                this._emitCodePoint(cp);
                for (let i = 0; i < SEQUENCES.SCRIPT.length; i++) {
                    this._emitCodePoint(this._consume());
                }
                this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED;
            }
            else if (!this._ensureHibernation()) {
                this.state = State$1.SCRIPT_DATA_ESCAPED;
                this._stateScriptDataEscaped(cp);
            }
        }
        // Script data double escaped state
        //------------------------------------------------------------------
        _stateScriptDataDoubleEscaped(cp) {
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED_DASH;
                    this._emitChars('-');
                    break;
                }
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN;
                    this._emitChars('<');
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this._emitChars(REPLACEMENT_CHARACTER);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInScriptHtmlCommentLikeText);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._emitCodePoint(cp);
                }
            }
        }
        // Script data double escaped dash state
        //------------------------------------------------------------------
        _stateScriptDataDoubleEscapedDash(cp) {
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH;
                    this._emitChars('-');
                    break;
                }
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN;
                    this._emitChars('<');
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED;
                    this._emitChars(REPLACEMENT_CHARACTER);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInScriptHtmlCommentLikeText);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED;
                    this._emitCodePoint(cp);
                }
            }
        }
        // Script data double escaped dash dash state
        //------------------------------------------------------------------
        _stateScriptDataDoubleEscapedDashDash(cp) {
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    this._emitChars('-');
                    break;
                }
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN;
                    this._emitChars('<');
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.SCRIPT_DATA;
                    this._emitChars('>');
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED;
                    this._emitChars(REPLACEMENT_CHARACTER);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInScriptHtmlCommentLikeText);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED;
                    this._emitCodePoint(cp);
                }
            }
        }
        // Script data double escaped less-than sign state
        //------------------------------------------------------------------
        _stateScriptDataDoubleEscapedLessThanSign(cp) {
            if (cp === CODE_POINTS.SOLIDUS) {
                this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPE_END;
                this._emitChars('/');
            }
            else {
                this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED;
                this._stateScriptDataDoubleEscaped(cp);
            }
        }
        // Script data double escape end state
        //------------------------------------------------------------------
        _stateScriptDataDoubleEscapeEnd(cp) {
            if (this.preprocessor.startsWith(SEQUENCES.SCRIPT, false) &&
                isScriptDataDoubleEscapeSequenceEnd(this.preprocessor.peek(SEQUENCES.SCRIPT.length))) {
                this._emitCodePoint(cp);
                for (let i = 0; i < SEQUENCES.SCRIPT.length; i++) {
                    this._emitCodePoint(this._consume());
                }
                this.state = State$1.SCRIPT_DATA_ESCAPED;
            }
            else if (!this._ensureHibernation()) {
                this.state = State$1.SCRIPT_DATA_DOUBLE_ESCAPED;
                this._stateScriptDataDoubleEscaped(cp);
            }
        }
        // Before attribute name state
        //------------------------------------------------------------------
        _stateBeforeAttributeName(cp) {
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    // Ignore whitespace
                    break;
                }
                case CODE_POINTS.SOLIDUS:
                case CODE_POINTS.GREATER_THAN_SIGN:
                case CODE_POINTS.EOF: {
                    this.state = State$1.AFTER_ATTRIBUTE_NAME;
                    this._stateAfterAttributeName(cp);
                    break;
                }
                case CODE_POINTS.EQUALS_SIGN: {
                    this._err(ERR.unexpectedEqualsSignBeforeAttributeName);
                    this._createAttr('=');
                    this.state = State$1.ATTRIBUTE_NAME;
                    break;
                }
                default: {
                    this._createAttr('');
                    this.state = State$1.ATTRIBUTE_NAME;
                    this._stateAttributeName(cp);
                }
            }
        }
        // Attribute name state
        //------------------------------------------------------------------
        _stateAttributeName(cp) {
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED:
                case CODE_POINTS.SOLIDUS:
                case CODE_POINTS.GREATER_THAN_SIGN:
                case CODE_POINTS.EOF: {
                    this._leaveAttrName();
                    this.state = State$1.AFTER_ATTRIBUTE_NAME;
                    this._stateAfterAttributeName(cp);
                    break;
                }
                case CODE_POINTS.EQUALS_SIGN: {
                    this._leaveAttrName();
                    this.state = State$1.BEFORE_ATTRIBUTE_VALUE;
                    break;
                }
                case CODE_POINTS.QUOTATION_MARK:
                case CODE_POINTS.APOSTROPHE:
                case CODE_POINTS.LESS_THAN_SIGN: {
                    this._err(ERR.unexpectedCharacterInAttributeName);
                    this.currentAttr.name += String.fromCodePoint(cp);
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this.currentAttr.name += REPLACEMENT_CHARACTER;
                    break;
                }
                default: {
                    this.currentAttr.name += String.fromCodePoint(isAsciiUpper(cp) ? toAsciiLower(cp) : cp);
                }
            }
        }
        // After attribute name state
        //------------------------------------------------------------------
        _stateAfterAttributeName(cp) {
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    // Ignore whitespace
                    break;
                }
                case CODE_POINTS.SOLIDUS: {
                    this.state = State$1.SELF_CLOSING_START_TAG;
                    break;
                }
                case CODE_POINTS.EQUALS_SIGN: {
                    this.state = State$1.BEFORE_ATTRIBUTE_VALUE;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.DATA;
                    this.emitCurrentTagToken();
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInTag);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._createAttr('');
                    this.state = State$1.ATTRIBUTE_NAME;
                    this._stateAttributeName(cp);
                }
            }
        }
        // Before attribute value state
        //------------------------------------------------------------------
        _stateBeforeAttributeValue(cp) {
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    // Ignore whitespace
                    break;
                }
                case CODE_POINTS.QUOTATION_MARK: {
                    this.state = State$1.ATTRIBUTE_VALUE_DOUBLE_QUOTED;
                    break;
                }
                case CODE_POINTS.APOSTROPHE: {
                    this.state = State$1.ATTRIBUTE_VALUE_SINGLE_QUOTED;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.missingAttributeValue);
                    this.state = State$1.DATA;
                    this.emitCurrentTagToken();
                    break;
                }
                default: {
                    this.state = State$1.ATTRIBUTE_VALUE_UNQUOTED;
                    this._stateAttributeValueUnquoted(cp);
                }
            }
        }
        // Attribute value (double-quoted) state
        //------------------------------------------------------------------
        _stateAttributeValueDoubleQuoted(cp) {
            switch (cp) {
                case CODE_POINTS.QUOTATION_MARK: {
                    this.state = State$1.AFTER_ATTRIBUTE_VALUE_QUOTED;
                    break;
                }
                case CODE_POINTS.AMPERSAND: {
                    this.returnState = State$1.ATTRIBUTE_VALUE_DOUBLE_QUOTED;
                    this.state = State$1.CHARACTER_REFERENCE;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this.currentAttr.value += REPLACEMENT_CHARACTER;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInTag);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this.currentAttr.value += String.fromCodePoint(cp);
                }
            }
        }
        // Attribute value (single-quoted) state
        //------------------------------------------------------------------
        _stateAttributeValueSingleQuoted(cp) {
            switch (cp) {
                case CODE_POINTS.APOSTROPHE: {
                    this.state = State$1.AFTER_ATTRIBUTE_VALUE_QUOTED;
                    break;
                }
                case CODE_POINTS.AMPERSAND: {
                    this.returnState = State$1.ATTRIBUTE_VALUE_SINGLE_QUOTED;
                    this.state = State$1.CHARACTER_REFERENCE;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this.currentAttr.value += REPLACEMENT_CHARACTER;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInTag);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this.currentAttr.value += String.fromCodePoint(cp);
                }
            }
        }
        // Attribute value (unquoted) state
        //------------------------------------------------------------------
        _stateAttributeValueUnquoted(cp) {
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    this._leaveAttrValue();
                    this.state = State$1.BEFORE_ATTRIBUTE_NAME;
                    break;
                }
                case CODE_POINTS.AMPERSAND: {
                    this.returnState = State$1.ATTRIBUTE_VALUE_UNQUOTED;
                    this.state = State$1.CHARACTER_REFERENCE;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._leaveAttrValue();
                    this.state = State$1.DATA;
                    this.emitCurrentTagToken();
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    this.currentAttr.value += REPLACEMENT_CHARACTER;
                    break;
                }
                case CODE_POINTS.QUOTATION_MARK:
                case CODE_POINTS.APOSTROPHE:
                case CODE_POINTS.LESS_THAN_SIGN:
                case CODE_POINTS.EQUALS_SIGN:
                case CODE_POINTS.GRAVE_ACCENT: {
                    this._err(ERR.unexpectedCharacterInUnquotedAttributeValue);
                    this.currentAttr.value += String.fromCodePoint(cp);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInTag);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this.currentAttr.value += String.fromCodePoint(cp);
                }
            }
        }
        // After attribute value (quoted) state
        //------------------------------------------------------------------
        _stateAfterAttributeValueQuoted(cp) {
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    this._leaveAttrValue();
                    this.state = State$1.BEFORE_ATTRIBUTE_NAME;
                    break;
                }
                case CODE_POINTS.SOLIDUS: {
                    this._leaveAttrValue();
                    this.state = State$1.SELF_CLOSING_START_TAG;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._leaveAttrValue();
                    this.state = State$1.DATA;
                    this.emitCurrentTagToken();
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInTag);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._err(ERR.missingWhitespaceBetweenAttributes);
                    this.state = State$1.BEFORE_ATTRIBUTE_NAME;
                    this._stateBeforeAttributeName(cp);
                }
            }
        }
        // Self-closing start tag state
        //------------------------------------------------------------------
        _stateSelfClosingStartTag(cp) {
            switch (cp) {
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    const token = this.currentToken;
                    token.selfClosing = true;
                    this.state = State$1.DATA;
                    this.emitCurrentTagToken();
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInTag);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._err(ERR.unexpectedSolidusInTag);
                    this.state = State$1.BEFORE_ATTRIBUTE_NAME;
                    this._stateBeforeAttributeName(cp);
                }
            }
        }
        // Bogus comment state
        //------------------------------------------------------------------
        _stateBogusComment(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.DATA;
                    this.emitCurrentComment(token);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this.emitCurrentComment(token);
                    this._emitEOFToken();
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    token.data += REPLACEMENT_CHARACTER;
                    break;
                }
                default: {
                    token.data += String.fromCodePoint(cp);
                }
            }
        }
        // Markup declaration open state
        //------------------------------------------------------------------
        _stateMarkupDeclarationOpen(cp) {
            if (this._consumeSequenceIfMatch(SEQUENCES.DASH_DASH, true)) {
                this._createCommentToken(SEQUENCES.DASH_DASH.length + 1);
                this.state = State$1.COMMENT_START;
            }
            else if (this._consumeSequenceIfMatch(SEQUENCES.DOCTYPE, false)) {
                // NOTE: Doctypes tokens are created without fixed offsets. We keep track of the moment a doctype *might* start here.
                this.currentLocation = this.getCurrentLocation(SEQUENCES.DOCTYPE.length + 1);
                this.state = State$1.DOCTYPE;
            }
            else if (this._consumeSequenceIfMatch(SEQUENCES.CDATA_START, true)) {
                if (this.inForeignNode) {
                    this.state = State$1.CDATA_SECTION;
                }
                else {
                    this._err(ERR.cdataInHtmlContent);
                    this._createCommentToken(SEQUENCES.CDATA_START.length + 1);
                    this.currentToken.data = '[CDATA[';
                    this.state = State$1.BOGUS_COMMENT;
                }
            }
            //NOTE: Sequence lookups can be abrupted by hibernation. In that case, lookup
            //results are no longer valid and we will need to start over.
            else if (!this._ensureHibernation()) {
                this._err(ERR.incorrectlyOpenedComment);
                this._createCommentToken(2);
                this.state = State$1.BOGUS_COMMENT;
                this._stateBogusComment(cp);
            }
        }
        // Comment start state
        //------------------------------------------------------------------
        _stateCommentStart(cp) {
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    this.state = State$1.COMMENT_START_DASH;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.abruptClosingOfEmptyComment);
                    this.state = State$1.DATA;
                    const token = this.currentToken;
                    this.emitCurrentComment(token);
                    break;
                }
                default: {
                    this.state = State$1.COMMENT;
                    this._stateComment(cp);
                }
            }
        }
        // Comment start dash state
        //------------------------------------------------------------------
        _stateCommentStartDash(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    this.state = State$1.COMMENT_END;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.abruptClosingOfEmptyComment);
                    this.state = State$1.DATA;
                    this.emitCurrentComment(token);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInComment);
                    this.emitCurrentComment(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.data += '-';
                    this.state = State$1.COMMENT;
                    this._stateComment(cp);
                }
            }
        }
        // Comment state
        //------------------------------------------------------------------
        _stateComment(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    this.state = State$1.COMMENT_END_DASH;
                    break;
                }
                case CODE_POINTS.LESS_THAN_SIGN: {
                    token.data += '<';
                    this.state = State$1.COMMENT_LESS_THAN_SIGN;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    token.data += REPLACEMENT_CHARACTER;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInComment);
                    this.emitCurrentComment(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.data += String.fromCodePoint(cp);
                }
            }
        }
        // Comment less-than sign state
        //------------------------------------------------------------------
        _stateCommentLessThanSign(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.EXCLAMATION_MARK: {
                    token.data += '!';
                    this.state = State$1.COMMENT_LESS_THAN_SIGN_BANG;
                    break;
                }
                case CODE_POINTS.LESS_THAN_SIGN: {
                    token.data += '<';
                    break;
                }
                default: {
                    this.state = State$1.COMMENT;
                    this._stateComment(cp);
                }
            }
        }
        // Comment less-than sign bang state
        //------------------------------------------------------------------
        _stateCommentLessThanSignBang(cp) {
            if (cp === CODE_POINTS.HYPHEN_MINUS) {
                this.state = State$1.COMMENT_LESS_THAN_SIGN_BANG_DASH;
            }
            else {
                this.state = State$1.COMMENT;
                this._stateComment(cp);
            }
        }
        // Comment less-than sign bang dash state
        //------------------------------------------------------------------
        _stateCommentLessThanSignBangDash(cp) {
            if (cp === CODE_POINTS.HYPHEN_MINUS) {
                this.state = State$1.COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH;
            }
            else {
                this.state = State$1.COMMENT_END_DASH;
                this._stateCommentEndDash(cp);
            }
        }
        // Comment less-than sign bang dash dash state
        //------------------------------------------------------------------
        _stateCommentLessThanSignBangDashDash(cp) {
            if (cp !== CODE_POINTS.GREATER_THAN_SIGN && cp !== CODE_POINTS.EOF) {
                this._err(ERR.nestedComment);
            }
            this.state = State$1.COMMENT_END;
            this._stateCommentEnd(cp);
        }
        // Comment end dash state
        //------------------------------------------------------------------
        _stateCommentEndDash(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    this.state = State$1.COMMENT_END;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInComment);
                    this.emitCurrentComment(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.data += '-';
                    this.state = State$1.COMMENT;
                    this._stateComment(cp);
                }
            }
        }
        // Comment end state
        //------------------------------------------------------------------
        _stateCommentEnd(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.DATA;
                    this.emitCurrentComment(token);
                    break;
                }
                case CODE_POINTS.EXCLAMATION_MARK: {
                    this.state = State$1.COMMENT_END_BANG;
                    break;
                }
                case CODE_POINTS.HYPHEN_MINUS: {
                    token.data += '-';
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInComment);
                    this.emitCurrentComment(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.data += '--';
                    this.state = State$1.COMMENT;
                    this._stateComment(cp);
                }
            }
        }
        // Comment end bang state
        //------------------------------------------------------------------
        _stateCommentEndBang(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.HYPHEN_MINUS: {
                    token.data += '--!';
                    this.state = State$1.COMMENT_END_DASH;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.incorrectlyClosedComment);
                    this.state = State$1.DATA;
                    this.emitCurrentComment(token);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInComment);
                    this.emitCurrentComment(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.data += '--!';
                    this.state = State$1.COMMENT;
                    this._stateComment(cp);
                }
            }
        }
        // DOCTYPE state
        //------------------------------------------------------------------
        _stateDoctype(cp) {
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    this.state = State$1.BEFORE_DOCTYPE_NAME;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.BEFORE_DOCTYPE_NAME;
                    this._stateBeforeDoctypeName(cp);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    this._createDoctypeToken(null);
                    const token = this.currentToken;
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._err(ERR.missingWhitespaceBeforeDoctypeName);
                    this.state = State$1.BEFORE_DOCTYPE_NAME;
                    this._stateBeforeDoctypeName(cp);
                }
            }
        }
        // Before DOCTYPE name state
        //------------------------------------------------------------------
        _stateBeforeDoctypeName(cp) {
            if (isAsciiUpper(cp)) {
                this._createDoctypeToken(String.fromCharCode(toAsciiLower(cp)));
                this.state = State$1.DOCTYPE_NAME;
            }
            else
                switch (cp) {
                    case CODE_POINTS.SPACE:
                    case CODE_POINTS.LINE_FEED:
                    case CODE_POINTS.TABULATION:
                    case CODE_POINTS.FORM_FEED: {
                        // Ignore whitespace
                        break;
                    }
                    case CODE_POINTS.NULL: {
                        this._err(ERR.unexpectedNullCharacter);
                        this._createDoctypeToken(REPLACEMENT_CHARACTER);
                        this.state = State$1.DOCTYPE_NAME;
                        break;
                    }
                    case CODE_POINTS.GREATER_THAN_SIGN: {
                        this._err(ERR.missingDoctypeName);
                        this._createDoctypeToken(null);
                        const token = this.currentToken;
                        token.forceQuirks = true;
                        this.emitCurrentDoctype(token);
                        this.state = State$1.DATA;
                        break;
                    }
                    case CODE_POINTS.EOF: {
                        this._err(ERR.eofInDoctype);
                        this._createDoctypeToken(null);
                        const token = this.currentToken;
                        token.forceQuirks = true;
                        this.emitCurrentDoctype(token);
                        this._emitEOFToken();
                        break;
                    }
                    default: {
                        this._createDoctypeToken(String.fromCodePoint(cp));
                        this.state = State$1.DOCTYPE_NAME;
                    }
                }
        }
        // DOCTYPE name state
        //------------------------------------------------------------------
        _stateDoctypeName(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    this.state = State$1.AFTER_DOCTYPE_NAME;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.DATA;
                    this.emitCurrentDoctype(token);
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    token.name += REPLACEMENT_CHARACTER;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.name += String.fromCodePoint(isAsciiUpper(cp) ? toAsciiLower(cp) : cp);
                }
            }
        }
        // After DOCTYPE name state
        //------------------------------------------------------------------
        _stateAfterDoctypeName(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    // Ignore whitespace
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.DATA;
                    this.emitCurrentDoctype(token);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default:
                    if (this._consumeSequenceIfMatch(SEQUENCES.PUBLIC, false)) {
                        this.state = State$1.AFTER_DOCTYPE_PUBLIC_KEYWORD;
                    }
                    else if (this._consumeSequenceIfMatch(SEQUENCES.SYSTEM, false)) {
                        this.state = State$1.AFTER_DOCTYPE_SYSTEM_KEYWORD;
                    }
                    //NOTE: sequence lookup can be abrupted by hibernation. In that case lookup
                    //results are no longer valid and we will need to start over.
                    else if (!this._ensureHibernation()) {
                        this._err(ERR.invalidCharacterSequenceAfterDoctypeName);
                        token.forceQuirks = true;
                        this.state = State$1.BOGUS_DOCTYPE;
                        this._stateBogusDoctype(cp);
                    }
            }
        }
        // After DOCTYPE public keyword state
        //------------------------------------------------------------------
        _stateAfterDoctypePublicKeyword(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    this.state = State$1.BEFORE_DOCTYPE_PUBLIC_IDENTIFIER;
                    break;
                }
                case CODE_POINTS.QUOTATION_MARK: {
                    this._err(ERR.missingWhitespaceAfterDoctypePublicKeyword);
                    token.publicId = '';
                    this.state = State$1.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED;
                    break;
                }
                case CODE_POINTS.APOSTROPHE: {
                    this._err(ERR.missingWhitespaceAfterDoctypePublicKeyword);
                    token.publicId = '';
                    this.state = State$1.DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.missingDoctypePublicIdentifier);
                    token.forceQuirks = true;
                    this.state = State$1.DATA;
                    this.emitCurrentDoctype(token);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._err(ERR.missingQuoteBeforeDoctypePublicIdentifier);
                    token.forceQuirks = true;
                    this.state = State$1.BOGUS_DOCTYPE;
                    this._stateBogusDoctype(cp);
                }
            }
        }
        // Before DOCTYPE public identifier state
        //------------------------------------------------------------------
        _stateBeforeDoctypePublicIdentifier(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    // Ignore whitespace
                    break;
                }
                case CODE_POINTS.QUOTATION_MARK: {
                    token.publicId = '';
                    this.state = State$1.DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED;
                    break;
                }
                case CODE_POINTS.APOSTROPHE: {
                    token.publicId = '';
                    this.state = State$1.DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.missingDoctypePublicIdentifier);
                    token.forceQuirks = true;
                    this.state = State$1.DATA;
                    this.emitCurrentDoctype(token);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._err(ERR.missingQuoteBeforeDoctypePublicIdentifier);
                    token.forceQuirks = true;
                    this.state = State$1.BOGUS_DOCTYPE;
                    this._stateBogusDoctype(cp);
                }
            }
        }
        // DOCTYPE public identifier (double-quoted) state
        //------------------------------------------------------------------
        _stateDoctypePublicIdentifierDoubleQuoted(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.QUOTATION_MARK: {
                    this.state = State$1.AFTER_DOCTYPE_PUBLIC_IDENTIFIER;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    token.publicId += REPLACEMENT_CHARACTER;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.abruptDoctypePublicIdentifier);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this.state = State$1.DATA;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.publicId += String.fromCodePoint(cp);
                }
            }
        }
        // DOCTYPE public identifier (single-quoted) state
        //------------------------------------------------------------------
        _stateDoctypePublicIdentifierSingleQuoted(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.APOSTROPHE: {
                    this.state = State$1.AFTER_DOCTYPE_PUBLIC_IDENTIFIER;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    token.publicId += REPLACEMENT_CHARACTER;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.abruptDoctypePublicIdentifier);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this.state = State$1.DATA;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.publicId += String.fromCodePoint(cp);
                }
            }
        }
        // After DOCTYPE public identifier state
        //------------------------------------------------------------------
        _stateAfterDoctypePublicIdentifier(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    this.state = State$1.BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.DATA;
                    this.emitCurrentDoctype(token);
                    break;
                }
                case CODE_POINTS.QUOTATION_MARK: {
                    this._err(ERR.missingWhitespaceBetweenDoctypePublicAndSystemIdentifiers);
                    token.systemId = '';
                    this.state = State$1.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
                    break;
                }
                case CODE_POINTS.APOSTROPHE: {
                    this._err(ERR.missingWhitespaceBetweenDoctypePublicAndSystemIdentifiers);
                    token.systemId = '';
                    this.state = State$1.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._err(ERR.missingQuoteBeforeDoctypeSystemIdentifier);
                    token.forceQuirks = true;
                    this.state = State$1.BOGUS_DOCTYPE;
                    this._stateBogusDoctype(cp);
                }
            }
        }
        // Between DOCTYPE public and system identifiers state
        //------------------------------------------------------------------
        _stateBetweenDoctypePublicAndSystemIdentifiers(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    // Ignore whitespace
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.emitCurrentDoctype(token);
                    this.state = State$1.DATA;
                    break;
                }
                case CODE_POINTS.QUOTATION_MARK: {
                    token.systemId = '';
                    this.state = State$1.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
                    break;
                }
                case CODE_POINTS.APOSTROPHE: {
                    token.systemId = '';
                    this.state = State$1.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._err(ERR.missingQuoteBeforeDoctypeSystemIdentifier);
                    token.forceQuirks = true;
                    this.state = State$1.BOGUS_DOCTYPE;
                    this._stateBogusDoctype(cp);
                }
            }
        }
        // After DOCTYPE system keyword state
        //------------------------------------------------------------------
        _stateAfterDoctypeSystemKeyword(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    this.state = State$1.BEFORE_DOCTYPE_SYSTEM_IDENTIFIER;
                    break;
                }
                case CODE_POINTS.QUOTATION_MARK: {
                    this._err(ERR.missingWhitespaceAfterDoctypeSystemKeyword);
                    token.systemId = '';
                    this.state = State$1.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
                    break;
                }
                case CODE_POINTS.APOSTROPHE: {
                    this._err(ERR.missingWhitespaceAfterDoctypeSystemKeyword);
                    token.systemId = '';
                    this.state = State$1.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.missingDoctypeSystemIdentifier);
                    token.forceQuirks = true;
                    this.state = State$1.DATA;
                    this.emitCurrentDoctype(token);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._err(ERR.missingQuoteBeforeDoctypeSystemIdentifier);
                    token.forceQuirks = true;
                    this.state = State$1.BOGUS_DOCTYPE;
                    this._stateBogusDoctype(cp);
                }
            }
        }
        // Before DOCTYPE system identifier state
        //------------------------------------------------------------------
        _stateBeforeDoctypeSystemIdentifier(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    // Ignore whitespace
                    break;
                }
                case CODE_POINTS.QUOTATION_MARK: {
                    token.systemId = '';
                    this.state = State$1.DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED;
                    break;
                }
                case CODE_POINTS.APOSTROPHE: {
                    token.systemId = '';
                    this.state = State$1.DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.missingDoctypeSystemIdentifier);
                    token.forceQuirks = true;
                    this.state = State$1.DATA;
                    this.emitCurrentDoctype(token);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._err(ERR.missingQuoteBeforeDoctypeSystemIdentifier);
                    token.forceQuirks = true;
                    this.state = State$1.BOGUS_DOCTYPE;
                    this._stateBogusDoctype(cp);
                }
            }
        }
        // DOCTYPE system identifier (double-quoted) state
        //------------------------------------------------------------------
        _stateDoctypeSystemIdentifierDoubleQuoted(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.QUOTATION_MARK: {
                    this.state = State$1.AFTER_DOCTYPE_SYSTEM_IDENTIFIER;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    token.systemId += REPLACEMENT_CHARACTER;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.abruptDoctypeSystemIdentifier);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this.state = State$1.DATA;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.systemId += String.fromCodePoint(cp);
                }
            }
        }
        // DOCTYPE system identifier (single-quoted) state
        //------------------------------------------------------------------
        _stateDoctypeSystemIdentifierSingleQuoted(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.APOSTROPHE: {
                    this.state = State$1.AFTER_DOCTYPE_SYSTEM_IDENTIFIER;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    token.systemId += REPLACEMENT_CHARACTER;
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this._err(ERR.abruptDoctypeSystemIdentifier);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this.state = State$1.DATA;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    token.systemId += String.fromCodePoint(cp);
                }
            }
        }
        // After DOCTYPE system identifier state
        //------------------------------------------------------------------
        _stateAfterDoctypeSystemIdentifier(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.SPACE:
                case CODE_POINTS.LINE_FEED:
                case CODE_POINTS.TABULATION:
                case CODE_POINTS.FORM_FEED: {
                    // Ignore whitespace
                    break;
                }
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.emitCurrentDoctype(token);
                    this.state = State$1.DATA;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInDoctype);
                    token.forceQuirks = true;
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._err(ERR.unexpectedCharacterAfterDoctypeSystemIdentifier);
                    this.state = State$1.BOGUS_DOCTYPE;
                    this._stateBogusDoctype(cp);
                }
            }
        }
        // Bogus DOCTYPE state
        //------------------------------------------------------------------
        _stateBogusDoctype(cp) {
            const token = this.currentToken;
            switch (cp) {
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.emitCurrentDoctype(token);
                    this.state = State$1.DATA;
                    break;
                }
                case CODE_POINTS.NULL: {
                    this._err(ERR.unexpectedNullCharacter);
                    break;
                }
                case CODE_POINTS.EOF: {
                    this.emitCurrentDoctype(token);
                    this._emitEOFToken();
                    break;
                }
                // Do nothing
            }
        }
        // CDATA section state
        //------------------------------------------------------------------
        _stateCdataSection(cp) {
            switch (cp) {
                case CODE_POINTS.RIGHT_SQUARE_BRACKET: {
                    this.state = State$1.CDATA_SECTION_BRACKET;
                    break;
                }
                case CODE_POINTS.EOF: {
                    this._err(ERR.eofInCdata);
                    this._emitEOFToken();
                    break;
                }
                default: {
                    this._emitCodePoint(cp);
                }
            }
        }
        // CDATA section bracket state
        //------------------------------------------------------------------
        _stateCdataSectionBracket(cp) {
            if (cp === CODE_POINTS.RIGHT_SQUARE_BRACKET) {
                this.state = State$1.CDATA_SECTION_END;
            }
            else {
                this._emitChars(']');
                this.state = State$1.CDATA_SECTION;
                this._stateCdataSection(cp);
            }
        }
        // CDATA section end state
        //------------------------------------------------------------------
        _stateCdataSectionEnd(cp) {
            switch (cp) {
                case CODE_POINTS.GREATER_THAN_SIGN: {
                    this.state = State$1.DATA;
                    break;
                }
                case CODE_POINTS.RIGHT_SQUARE_BRACKET: {
                    this._emitChars(']');
                    break;
                }
                default: {
                    this._emitChars(']]');
                    this.state = State$1.CDATA_SECTION;
                    this._stateCdataSection(cp);
                }
            }
        }
        // Character reference state
        //------------------------------------------------------------------
        _stateCharacterReference(cp) {
            if (cp === CODE_POINTS.NUMBER_SIGN) {
                this.state = State$1.NUMERIC_CHARACTER_REFERENCE;
            }
            else if (isAsciiAlphaNumeric(cp)) {
                this.state = State$1.NAMED_CHARACTER_REFERENCE;
                this._stateNamedCharacterReference(cp);
            }
            else {
                this._flushCodePointConsumedAsCharacterReference(CODE_POINTS.AMPERSAND);
                this._reconsumeInState(this.returnState);
            }
        }
        // Named character reference state
        //------------------------------------------------------------------
        _stateNamedCharacterReference(cp) {
            const matchResult = this._matchNamedCharacterReference(cp);
            //NOTE: Matching can be abrupted by hibernation. In that case, match
            //results are no longer valid and we will need to start over.
            if (this._ensureHibernation()) ;
            else if (matchResult) {
                for (let i = 0; i < matchResult.length; i++) {
                    this._flushCodePointConsumedAsCharacterReference(matchResult[i]);
                }
                this.state = this.returnState;
            }
            else {
                this._flushCodePointConsumedAsCharacterReference(CODE_POINTS.AMPERSAND);
                this.state = State$1.AMBIGUOUS_AMPERSAND;
            }
        }
        // Ambiguos ampersand state
        //------------------------------------------------------------------
        _stateAmbiguousAmpersand(cp) {
            if (isAsciiAlphaNumeric(cp)) {
                this._flushCodePointConsumedAsCharacterReference(cp);
            }
            else {
                if (cp === CODE_POINTS.SEMICOLON) {
                    this._err(ERR.unknownNamedCharacterReference);
                }
                this._reconsumeInState(this.returnState);
            }
        }
        // Numeric character reference state
        //------------------------------------------------------------------
        _stateNumericCharacterReference(cp) {
            this.charRefCode = 0;
            if (cp === CODE_POINTS.LATIN_SMALL_X || cp === CODE_POINTS.LATIN_CAPITAL_X) {
                this.state = State$1.HEXADEMICAL_CHARACTER_REFERENCE_START;
            }
            else {
                this.state = State$1.DECIMAL_CHARACTER_REFERENCE_START;
                this._stateDecimalCharacterReferenceStart(cp);
            }
        }
        // Hexademical character reference start state
        //------------------------------------------------------------------
        _stateHexademicalCharacterReferenceStart(cp) {
            if (isAsciiHexDigit(cp)) {
                this.state = State$1.HEXADEMICAL_CHARACTER_REFERENCE;
                this._stateHexademicalCharacterReference(cp);
            }
            else {
                this._err(ERR.absenceOfDigitsInNumericCharacterReference);
                this._flushCodePointConsumedAsCharacterReference(CODE_POINTS.AMPERSAND);
                this._flushCodePointConsumedAsCharacterReference(CODE_POINTS.NUMBER_SIGN);
                this._unconsume(2);
                this.state = this.returnState;
            }
        }
        // Decimal character reference start state
        //------------------------------------------------------------------
        _stateDecimalCharacterReferenceStart(cp) {
            if (isAsciiDigit(cp)) {
                this.state = State$1.DECIMAL_CHARACTER_REFERENCE;
                this._stateDecimalCharacterReference(cp);
            }
            else {
                this._err(ERR.absenceOfDigitsInNumericCharacterReference);
                this._flushCodePointConsumedAsCharacterReference(CODE_POINTS.AMPERSAND);
                this._flushCodePointConsumedAsCharacterReference(CODE_POINTS.NUMBER_SIGN);
                this._reconsumeInState(this.returnState);
            }
        }
        // Hexademical character reference state
        //------------------------------------------------------------------
        _stateHexademicalCharacterReference(cp) {
            if (isAsciiUpperHexDigit(cp)) {
                this.charRefCode = this.charRefCode * 16 + cp - 0x37;
            }
            else if (isAsciiLowerHexDigit(cp)) {
                this.charRefCode = this.charRefCode * 16 + cp - 0x57;
            }
            else if (isAsciiDigit(cp)) {
                this.charRefCode = this.charRefCode * 16 + cp - 0x30;
            }
            else if (cp === CODE_POINTS.SEMICOLON) {
                this.state = State$1.NUMERIC_CHARACTER_REFERENCE_END;
            }
            else {
                this._err(ERR.missingSemicolonAfterCharacterReference);
                this.state = State$1.NUMERIC_CHARACTER_REFERENCE_END;
                this._stateNumericCharacterReferenceEnd();
            }
        }
        // Decimal character reference state
        //------------------------------------------------------------------
        _stateDecimalCharacterReference(cp) {
            if (isAsciiDigit(cp)) {
                this.charRefCode = this.charRefCode * 10 + cp - 0x30;
            }
            else if (cp === CODE_POINTS.SEMICOLON) {
                this.state = State$1.NUMERIC_CHARACTER_REFERENCE_END;
            }
            else {
                this._err(ERR.missingSemicolonAfterCharacterReference);
                this.state = State$1.NUMERIC_CHARACTER_REFERENCE_END;
                this._stateNumericCharacterReferenceEnd();
            }
        }
        // Numeric character reference end state
        //------------------------------------------------------------------
        _stateNumericCharacterReferenceEnd() {
            if (this.charRefCode === CODE_POINTS.NULL) {
                this._err(ERR.nullCharacterReference);
                this.charRefCode = CODE_POINTS.REPLACEMENT_CHARACTER;
            }
            else if (this.charRefCode > 1114111) {
                this._err(ERR.characterReferenceOutsideUnicodeRange);
                this.charRefCode = CODE_POINTS.REPLACEMENT_CHARACTER;
            }
            else if (isSurrogate(this.charRefCode)) {
                this._err(ERR.surrogateCharacterReference);
                this.charRefCode = CODE_POINTS.REPLACEMENT_CHARACTER;
            }
            else if (isUndefinedCodePoint(this.charRefCode)) {
                this._err(ERR.noncharacterCharacterReference);
            }
            else if (isControlCodePoint(this.charRefCode) || this.charRefCode === CODE_POINTS.CARRIAGE_RETURN) {
                this._err(ERR.controlCharacterReference);
                const replacement = C1_CONTROLS_REFERENCE_REPLACEMENTS.get(this.charRefCode);
                if (replacement !== undefined) {
                    this.charRefCode = replacement;
                }
            }
            this._flushCodePointConsumedAsCharacterReference(this.charRefCode);
            this._reconsumeInState(this.returnState);
        }
    }

    //Element utils
    const IMPLICIT_END_TAG_REQUIRED = new Set([TAG_ID.DD, TAG_ID.DT, TAG_ID.LI, TAG_ID.OPTGROUP, TAG_ID.OPTION, TAG_ID.P, TAG_ID.RB, TAG_ID.RP, TAG_ID.RT, TAG_ID.RTC]);
    const IMPLICIT_END_TAG_REQUIRED_THOROUGHLY = new Set([
        ...IMPLICIT_END_TAG_REQUIRED,
        TAG_ID.CAPTION,
        TAG_ID.COLGROUP,
        TAG_ID.TBODY,
        TAG_ID.TD,
        TAG_ID.TFOOT,
        TAG_ID.TH,
        TAG_ID.THEAD,
        TAG_ID.TR,
    ]);
    const SCOPING_ELEMENT_NS = new Map([
        [TAG_ID.APPLET, NS.HTML],
        [TAG_ID.CAPTION, NS.HTML],
        [TAG_ID.HTML, NS.HTML],
        [TAG_ID.MARQUEE, NS.HTML],
        [TAG_ID.OBJECT, NS.HTML],
        [TAG_ID.TABLE, NS.HTML],
        [TAG_ID.TD, NS.HTML],
        [TAG_ID.TEMPLATE, NS.HTML],
        [TAG_ID.TH, NS.HTML],
        [TAG_ID.ANNOTATION_XML, NS.MATHML],
        [TAG_ID.MI, NS.MATHML],
        [TAG_ID.MN, NS.MATHML],
        [TAG_ID.MO, NS.MATHML],
        [TAG_ID.MS, NS.MATHML],
        [TAG_ID.MTEXT, NS.MATHML],
        [TAG_ID.DESC, NS.SVG],
        [TAG_ID.FOREIGN_OBJECT, NS.SVG],
        [TAG_ID.TITLE, NS.SVG],
    ]);
    const NAMED_HEADERS = [TAG_ID.H1, TAG_ID.H2, TAG_ID.H3, TAG_ID.H4, TAG_ID.H5, TAG_ID.H6];
    const TABLE_ROW_CONTEXT = [TAG_ID.TR, TAG_ID.TEMPLATE, TAG_ID.HTML];
    const TABLE_BODY_CONTEXT = [TAG_ID.TBODY, TAG_ID.TFOOT, TAG_ID.THEAD, TAG_ID.TEMPLATE, TAG_ID.HTML];
    const TABLE_CONTEXT = [TAG_ID.TABLE, TAG_ID.TEMPLATE, TAG_ID.HTML];
    const TABLE_CELLS = [TAG_ID.TD, TAG_ID.TH];
    //Stack of open elements
    class OpenElementStack {
        constructor(document, treeAdapter, handler) {
            this.treeAdapter = treeAdapter;
            this.handler = handler;
            this.items = [];
            this.tagIDs = [];
            this.stackTop = -1;
            this.tmplCount = 0;
            this.currentTagId = TAG_ID.UNKNOWN;
            this.current = document;
        }
        get currentTmplContentOrNode() {
            return this._isInTemplate() ? this.treeAdapter.getTemplateContent(this.current) : this.current;
        }
        //Index of element
        _indexOf(element) {
            return this.items.lastIndexOf(element, this.stackTop);
        }
        //Update current element
        _isInTemplate() {
            return this.currentTagId === TAG_ID.TEMPLATE && this.treeAdapter.getNamespaceURI(this.current) === NS.HTML;
        }
        _updateCurrentElement() {
            this.current = this.items[this.stackTop];
            this.currentTagId = this.tagIDs[this.stackTop];
        }
        //Mutations
        push(element, tagID) {
            this.stackTop++;
            this.items[this.stackTop] = element;
            this.current = element;
            this.tagIDs[this.stackTop] = tagID;
            this.currentTagId = tagID;
            if (this._isInTemplate()) {
                this.tmplCount++;
            }
            this.handler.onItemPush(element, tagID, true);
        }
        pop() {
            const popped = this.current;
            if (this.tmplCount > 0 && this._isInTemplate()) {
                this.tmplCount--;
            }
            this.stackTop--;
            this._updateCurrentElement();
            this.handler.onItemPop(popped, true);
        }
        replace(oldElement, newElement) {
            const idx = this._indexOf(oldElement);
            this.items[idx] = newElement;
            if (idx === this.stackTop) {
                this.current = newElement;
            }
        }
        insertAfter(referenceElement, newElement, newElementID) {
            const insertionIdx = this._indexOf(referenceElement) + 1;
            this.items.splice(insertionIdx, 0, newElement);
            this.tagIDs.splice(insertionIdx, 0, newElementID);
            this.stackTop++;
            if (insertionIdx === this.stackTop) {
                this._updateCurrentElement();
            }
            this.handler.onItemPush(this.current, this.currentTagId, insertionIdx === this.stackTop);
        }
        popUntilTagNamePopped(tagName) {
            let targetIdx = this.stackTop + 1;
            do {
                targetIdx = this.tagIDs.lastIndexOf(tagName, targetIdx - 1);
            } while (targetIdx > 0 && this.treeAdapter.getNamespaceURI(this.items[targetIdx]) !== NS.HTML);
            this.shortenToLength(targetIdx < 0 ? 0 : targetIdx);
        }
        shortenToLength(idx) {
            while (this.stackTop >= idx) {
                const popped = this.current;
                if (this.tmplCount > 0 && this._isInTemplate()) {
                    this.tmplCount -= 1;
                }
                this.stackTop--;
                this._updateCurrentElement();
                this.handler.onItemPop(popped, this.stackTop < idx);
            }
        }
        popUntilElementPopped(element) {
            const idx = this._indexOf(element);
            this.shortenToLength(idx < 0 ? 0 : idx);
        }
        popUntilPopped(tagNames, targetNS) {
            const idx = this._indexOfTagNames(tagNames, targetNS);
            this.shortenToLength(idx < 0 ? 0 : idx);
        }
        popUntilNumberedHeaderPopped() {
            this.popUntilPopped(NAMED_HEADERS, NS.HTML);
        }
        popUntilTableCellPopped() {
            this.popUntilPopped(TABLE_CELLS, NS.HTML);
        }
        popAllUpToHtmlElement() {
            //NOTE: here we assume that the root <html> element is always first in the open element stack, so
            //we perform this fast stack clean up.
            this.tmplCount = 0;
            this.shortenToLength(1);
        }
        _indexOfTagNames(tagNames, namespace) {
            for (let i = this.stackTop; i >= 0; i--) {
                if (tagNames.includes(this.tagIDs[i]) && this.treeAdapter.getNamespaceURI(this.items[i]) === namespace) {
                    return i;
                }
            }
            return -1;
        }
        clearBackTo(tagNames, targetNS) {
            const idx = this._indexOfTagNames(tagNames, targetNS);
            this.shortenToLength(idx + 1);
        }
        clearBackToTableContext() {
            this.clearBackTo(TABLE_CONTEXT, NS.HTML);
        }
        clearBackToTableBodyContext() {
            this.clearBackTo(TABLE_BODY_CONTEXT, NS.HTML);
        }
        clearBackToTableRowContext() {
            this.clearBackTo(TABLE_ROW_CONTEXT, NS.HTML);
        }
        remove(element) {
            const idx = this._indexOf(element);
            if (idx >= 0) {
                if (idx === this.stackTop) {
                    this.pop();
                }
                else {
                    this.items.splice(idx, 1);
                    this.tagIDs.splice(idx, 1);
                    this.stackTop--;
                    this._updateCurrentElement();
                    this.handler.onItemPop(element, false);
                }
            }
        }
        //Search
        tryPeekProperlyNestedBodyElement() {
            //Properly nested <body> element (should be second element in stack).
            return this.stackTop >= 1 && this.tagIDs[1] === TAG_ID.BODY ? this.items[1] : null;
        }
        contains(element) {
            return this._indexOf(element) > -1;
        }
        getCommonAncestor(element) {
            const elementIdx = this._indexOf(element) - 1;
            return elementIdx >= 0 ? this.items[elementIdx] : null;
        }
        isRootHtmlElementCurrent() {
            return this.stackTop === 0 && this.tagIDs[0] === TAG_ID.HTML;
        }
        //Element in scope
        hasInScope(tagName) {
            for (let i = this.stackTop; i >= 0; i--) {
                const tn = this.tagIDs[i];
                const ns = this.treeAdapter.getNamespaceURI(this.items[i]);
                if (tn === tagName && ns === NS.HTML) {
                    return true;
                }
                if (SCOPING_ELEMENT_NS.get(tn) === ns) {
                    return false;
                }
            }
            return true;
        }
        hasNumberedHeaderInScope() {
            for (let i = this.stackTop; i >= 0; i--) {
                const tn = this.tagIDs[i];
                const ns = this.treeAdapter.getNamespaceURI(this.items[i]);
                if (isNumberedHeader(tn) && ns === NS.HTML) {
                    return true;
                }
                if (SCOPING_ELEMENT_NS.get(tn) === ns) {
                    return false;
                }
            }
            return true;
        }
        hasInListItemScope(tagName) {
            for (let i = this.stackTop; i >= 0; i--) {
                const tn = this.tagIDs[i];
                const ns = this.treeAdapter.getNamespaceURI(this.items[i]);
                if (tn === tagName && ns === NS.HTML) {
                    return true;
                }
                if (((tn === TAG_ID.UL || tn === TAG_ID.OL) && ns === NS.HTML) || SCOPING_ELEMENT_NS.get(tn) === ns) {
                    return false;
                }
            }
            return true;
        }
        hasInButtonScope(tagName) {
            for (let i = this.stackTop; i >= 0; i--) {
                const tn = this.tagIDs[i];
                const ns = this.treeAdapter.getNamespaceURI(this.items[i]);
                if (tn === tagName && ns === NS.HTML) {
                    return true;
                }
                if ((tn === TAG_ID.BUTTON && ns === NS.HTML) || SCOPING_ELEMENT_NS.get(tn) === ns) {
                    return false;
                }
            }
            return true;
        }
        hasInTableScope(tagName) {
            for (let i = this.stackTop; i >= 0; i--) {
                const tn = this.tagIDs[i];
                const ns = this.treeAdapter.getNamespaceURI(this.items[i]);
                if (ns !== NS.HTML) {
                    continue;
                }
                if (tn === tagName) {
                    return true;
                }
                if (tn === TAG_ID.TABLE || tn === TAG_ID.TEMPLATE || tn === TAG_ID.HTML) {
                    return false;
                }
            }
            return true;
        }
        hasTableBodyContextInTableScope() {
            for (let i = this.stackTop; i >= 0; i--) {
                const tn = this.tagIDs[i];
                const ns = this.treeAdapter.getNamespaceURI(this.items[i]);
                if (ns !== NS.HTML) {
                    continue;
                }
                if (tn === TAG_ID.TBODY || tn === TAG_ID.THEAD || tn === TAG_ID.TFOOT) {
                    return true;
                }
                if (tn === TAG_ID.TABLE || tn === TAG_ID.HTML) {
                    return false;
                }
            }
            return true;
        }
        hasInSelectScope(tagName) {
            for (let i = this.stackTop; i >= 0; i--) {
                const tn = this.tagIDs[i];
                const ns = this.treeAdapter.getNamespaceURI(this.items[i]);
                if (ns !== NS.HTML) {
                    continue;
                }
                if (tn === tagName) {
                    return true;
                }
                if (tn !== TAG_ID.OPTION && tn !== TAG_ID.OPTGROUP) {
                    return false;
                }
            }
            return true;
        }
        //Implied end tags
        generateImpliedEndTags() {
            while (IMPLICIT_END_TAG_REQUIRED.has(this.currentTagId)) {
                this.pop();
            }
        }
        generateImpliedEndTagsThoroughly() {
            while (IMPLICIT_END_TAG_REQUIRED_THOROUGHLY.has(this.currentTagId)) {
                this.pop();
            }
        }
        generateImpliedEndTagsWithExclusion(exclusionId) {
            while (this.currentTagId !== exclusionId && IMPLICIT_END_TAG_REQUIRED_THOROUGHLY.has(this.currentTagId)) {
                this.pop();
            }
        }
    }

    //Const
    const NOAH_ARK_CAPACITY = 3;
    var EntryType;
    (function (EntryType) {
        EntryType[EntryType["Marker"] = 0] = "Marker";
        EntryType[EntryType["Element"] = 1] = "Element";
    })(EntryType || (EntryType = {}));
    const MARKER = { type: EntryType.Marker };
    //List of formatting elements
    class FormattingElementList {
        constructor(treeAdapter) {
            this.treeAdapter = treeAdapter;
            this.entries = [];
            this.bookmark = null;
        }
        //Noah Ark's condition
        //OPTIMIZATION: at first we try to find possible candidates for exclusion using
        //lightweight heuristics without thorough attributes check.
        _getNoahArkConditionCandidates(newElement, neAttrs) {
            const candidates = [];
            const neAttrsLength = neAttrs.length;
            const neTagName = this.treeAdapter.getTagName(newElement);
            const neNamespaceURI = this.treeAdapter.getNamespaceURI(newElement);
            for (let i = 0; i < this.entries.length; i++) {
                const entry = this.entries[i];
                if (entry.type === EntryType.Marker) {
                    break;
                }
                const { element } = entry;
                if (this.treeAdapter.getTagName(element) === neTagName &&
                    this.treeAdapter.getNamespaceURI(element) === neNamespaceURI) {
                    const elementAttrs = this.treeAdapter.getAttrList(element);
                    if (elementAttrs.length === neAttrsLength) {
                        candidates.push({ idx: i, attrs: elementAttrs });
                    }
                }
            }
            return candidates;
        }
        _ensureNoahArkCondition(newElement) {
            if (this.entries.length < NOAH_ARK_CAPACITY)
                return;
            const neAttrs = this.treeAdapter.getAttrList(newElement);
            const candidates = this._getNoahArkConditionCandidates(newElement, neAttrs);
            if (candidates.length < NOAH_ARK_CAPACITY)
                return;
            //NOTE: build attrs map for the new element, so we can perform fast lookups
            const neAttrsMap = new Map(neAttrs.map((neAttr) => [neAttr.name, neAttr.value]));
            let validCandidates = 0;
            //NOTE: remove bottommost candidates, until Noah's Ark condition will not be met
            for (let i = 0; i < candidates.length; i++) {
                const candidate = candidates[i];
                // We know that `candidate.attrs.length === neAttrs.length`
                if (candidate.attrs.every((cAttr) => neAttrsMap.get(cAttr.name) === cAttr.value)) {
                    validCandidates += 1;
                    if (validCandidates >= NOAH_ARK_CAPACITY) {
                        this.entries.splice(candidate.idx, 1);
                    }
                }
            }
        }
        //Mutations
        insertMarker() {
            this.entries.unshift(MARKER);
        }
        pushElement(element, token) {
            this._ensureNoahArkCondition(element);
            this.entries.unshift({
                type: EntryType.Element,
                element,
                token,
            });
        }
        insertElementAfterBookmark(element, token) {
            const bookmarkIdx = this.entries.indexOf(this.bookmark);
            this.entries.splice(bookmarkIdx, 0, {
                type: EntryType.Element,
                element,
                token,
            });
        }
        removeEntry(entry) {
            const entryIndex = this.entries.indexOf(entry);
            if (entryIndex >= 0) {
                this.entries.splice(entryIndex, 1);
            }
        }
        clearToLastMarker() {
            const markerIdx = this.entries.indexOf(MARKER);
            if (markerIdx >= 0) {
                this.entries.splice(0, markerIdx + 1);
            }
            else {
                this.entries.length = 0;
            }
        }
        //Search
        getElementEntryInScopeWithTagName(tagName) {
            const entry = this.entries.find((entry) => entry.type === EntryType.Marker || this.treeAdapter.getTagName(entry.element) === tagName);
            return entry && entry.type === EntryType.Element ? entry : null;
        }
        getElementEntry(element) {
            return this.entries.find((entry) => entry.type === EntryType.Element && entry.element === element);
        }
    }

    var NodeType;
    (function (NodeType) {
        NodeType["Document"] = "#document";
        NodeType["DocumentFragment"] = "#document-fragment";
        NodeType["Comment"] = "#comment";
        NodeType["Text"] = "#text";
        NodeType["DocumentType"] = "#documentType";
    })(NodeType || (NodeType = {}));
    function createTextNode$1(value) {
        return {
            nodeName: NodeType.Text,
            value,
            parentNode: null,
        };
    }
    const defaultTreeAdapter = {
        //Node construction
        createDocument() {
            return {
                nodeName: NodeType.Document,
                mode: DOCUMENT_MODE.NO_QUIRKS,
                childNodes: [],
            };
        },
        createDocumentFragment() {
            return {
                nodeName: NodeType.DocumentFragment,
                childNodes: [],
            };
        },
        createElement(tagName, namespaceURI, attrs) {
            return {
                nodeName: tagName,
                tagName,
                attrs,
                namespaceURI,
                childNodes: [],
                parentNode: null,
            };
        },
        createCommentNode(data) {
            return {
                nodeName: NodeType.Comment,
                data,
                parentNode: null,
            };
        },
        //Tree mutation
        appendChild(parentNode, newNode) {
            parentNode.childNodes.push(newNode);
            newNode.parentNode = parentNode;
        },
        insertBefore(parentNode, newNode, referenceNode) {
            const insertionIdx = parentNode.childNodes.indexOf(referenceNode);
            parentNode.childNodes.splice(insertionIdx, 0, newNode);
            newNode.parentNode = parentNode;
        },
        setTemplateContent(templateElement, contentElement) {
            templateElement.content = contentElement;
        },
        getTemplateContent(templateElement) {
            return templateElement.content;
        },
        setDocumentType(document, name, publicId, systemId) {
            const doctypeNode = document.childNodes.find((node) => node.nodeName === NodeType.DocumentType);
            if (doctypeNode) {
                doctypeNode.name = name;
                doctypeNode.publicId = publicId;
                doctypeNode.systemId = systemId;
            }
            else {
                const node = {
                    nodeName: NodeType.DocumentType,
                    name,
                    publicId,
                    systemId,
                    parentNode: null,
                };
                defaultTreeAdapter.appendChild(document, node);
            }
        },
        setDocumentMode(document, mode) {
            document.mode = mode;
        },
        getDocumentMode(document) {
            return document.mode;
        },
        detachNode(node) {
            if (node.parentNode) {
                const idx = node.parentNode.childNodes.indexOf(node);
                node.parentNode.childNodes.splice(idx, 1);
                node.parentNode = null;
            }
        },
        insertText(parentNode, text) {
            if (parentNode.childNodes.length > 0) {
                const prevNode = parentNode.childNodes[parentNode.childNodes.length - 1];
                if (defaultTreeAdapter.isTextNode(prevNode)) {
                    prevNode.value += text;
                    return;
                }
            }
            defaultTreeAdapter.appendChild(parentNode, createTextNode$1(text));
        },
        insertTextBefore(parentNode, text, referenceNode) {
            const prevNode = parentNode.childNodes[parentNode.childNodes.indexOf(referenceNode) - 1];
            if (prevNode && defaultTreeAdapter.isTextNode(prevNode)) {
                prevNode.value += text;
            }
            else {
                defaultTreeAdapter.insertBefore(parentNode, createTextNode$1(text), referenceNode);
            }
        },
        adoptAttributes(recipient, attrs) {
            const recipientAttrsMap = new Set(recipient.attrs.map((attr) => attr.name));
            for (let j = 0; j < attrs.length; j++) {
                if (!recipientAttrsMap.has(attrs[j].name)) {
                    recipient.attrs.push(attrs[j]);
                }
            }
        },
        //Tree traversing
        getFirstChild(node) {
            return node.childNodes[0];
        },
        getChildNodes(node) {
            return node.childNodes;
        },
        getParentNode(node) {
            return node.parentNode;
        },
        getAttrList(element) {
            return element.attrs;
        },
        //Node data
        getTagName(element) {
            return element.tagName;
        },
        getNamespaceURI(element) {
            return element.namespaceURI;
        },
        getTextNodeContent(textNode) {
            return textNode.value;
        },
        getCommentNodeContent(commentNode) {
            return commentNode.data;
        },
        getDocumentTypeNodeName(doctypeNode) {
            return doctypeNode.name;
        },
        getDocumentTypeNodePublicId(doctypeNode) {
            return doctypeNode.publicId;
        },
        getDocumentTypeNodeSystemId(doctypeNode) {
            return doctypeNode.systemId;
        },
        //Node types
        isTextNode(node) {
            return node.nodeName === '#text';
        },
        isCommentNode(node) {
            return node.nodeName === '#comment';
        },
        isDocumentTypeNode(node) {
            return node.nodeName === NodeType.DocumentType;
        },
        isElementNode(node) {
            return Object.prototype.hasOwnProperty.call(node, 'tagName');
        },
        // Source code location
        setNodeSourceCodeLocation(node, location) {
            node.sourceCodeLocation = location;
        },
        getNodeSourceCodeLocation(node) {
            return node.sourceCodeLocation;
        },
        updateNodeSourceCodeLocation(node, endLocation) {
            node.sourceCodeLocation = { ...node.sourceCodeLocation, ...endLocation };
        },
    };

    //Const
    const VALID_DOCTYPE_NAME = 'html';
    const VALID_SYSTEM_ID = 'about:legacy-compat';
    const QUIRKS_MODE_SYSTEM_ID = 'http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd';
    const QUIRKS_MODE_PUBLIC_ID_PREFIXES = [
        '+//silmaril//dtd html pro v0r11 19970101//',
        '-//as//dtd html 3.0 aswedit + extensions//',
        '-//advasoft ltd//dtd html 3.0 aswedit + extensions//',
        '-//ietf//dtd html 2.0 level 1//',
        '-//ietf//dtd html 2.0 level 2//',
        '-//ietf//dtd html 2.0 strict level 1//',
        '-//ietf//dtd html 2.0 strict level 2//',
        '-//ietf//dtd html 2.0 strict//',
        '-//ietf//dtd html 2.0//',
        '-//ietf//dtd html 2.1e//',
        '-//ietf//dtd html 3.0//',
        '-//ietf//dtd html 3.2 final//',
        '-//ietf//dtd html 3.2//',
        '-//ietf//dtd html 3//',
        '-//ietf//dtd html level 0//',
        '-//ietf//dtd html level 1//',
        '-//ietf//dtd html level 2//',
        '-//ietf//dtd html level 3//',
        '-//ietf//dtd html strict level 0//',
        '-//ietf//dtd html strict level 1//',
        '-//ietf//dtd html strict level 2//',
        '-//ietf//dtd html strict level 3//',
        '-//ietf//dtd html strict//',
        '-//ietf//dtd html//',
        '-//metrius//dtd metrius presentational//',
        '-//microsoft//dtd internet explorer 2.0 html strict//',
        '-//microsoft//dtd internet explorer 2.0 html//',
        '-//microsoft//dtd internet explorer 2.0 tables//',
        '-//microsoft//dtd internet explorer 3.0 html strict//',
        '-//microsoft//dtd internet explorer 3.0 html//',
        '-//microsoft//dtd internet explorer 3.0 tables//',
        '-//netscape comm. corp.//dtd html//',
        '-//netscape comm. corp.//dtd strict html//',
        "-//o'reilly and associates//dtd html 2.0//",
        "-//o'reilly and associates//dtd html extended 1.0//",
        "-//o'reilly and associates//dtd html extended relaxed 1.0//",
        '-//sq//dtd html 2.0 hotmetal + extensions//',
        '-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//',
        '-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//',
        '-//spyglass//dtd html 2.0 extended//',
        '-//sun microsystems corp.//dtd hotjava html//',
        '-//sun microsystems corp.//dtd hotjava strict html//',
        '-//w3c//dtd html 3 1995-03-24//',
        '-//w3c//dtd html 3.2 draft//',
        '-//w3c//dtd html 3.2 final//',
        '-//w3c//dtd html 3.2//',
        '-//w3c//dtd html 3.2s draft//',
        '-//w3c//dtd html 4.0 frameset//',
        '-//w3c//dtd html 4.0 transitional//',
        '-//w3c//dtd html experimental 19960712//',
        '-//w3c//dtd html experimental 970421//',
        '-//w3c//dtd w3 html//',
        '-//w3o//dtd w3 html 3.0//',
        '-//webtechs//dtd mozilla html 2.0//',
        '-//webtechs//dtd mozilla html//',
    ];
    const QUIRKS_MODE_NO_SYSTEM_ID_PUBLIC_ID_PREFIXES = [
        ...QUIRKS_MODE_PUBLIC_ID_PREFIXES,
        '-//w3c//dtd html 4.01 frameset//',
        '-//w3c//dtd html 4.01 transitional//',
    ];
    const QUIRKS_MODE_PUBLIC_IDS = new Set([
        '-//w3o//dtd w3 html strict 3.0//en//',
        '-/w3c/dtd html 4.0 transitional/en',
        'html',
    ]);
    const LIMITED_QUIRKS_PUBLIC_ID_PREFIXES = ['-//w3c//dtd xhtml 1.0 frameset//', '-//w3c//dtd xhtml 1.0 transitional//'];
    const LIMITED_QUIRKS_WITH_SYSTEM_ID_PUBLIC_ID_PREFIXES = [
        ...LIMITED_QUIRKS_PUBLIC_ID_PREFIXES,
        '-//w3c//dtd html 4.01 frameset//',
        '-//w3c//dtd html 4.01 transitional//',
    ];
    //Utils
    function hasPrefix(publicId, prefixes) {
        return prefixes.some((prefix) => publicId.startsWith(prefix));
    }
    //API
    function isConforming(token) {
        return (token.name === VALID_DOCTYPE_NAME &&
            token.publicId === null &&
            (token.systemId === null || token.systemId === VALID_SYSTEM_ID));
    }
    function getDocumentMode(token) {
        if (token.name !== VALID_DOCTYPE_NAME) {
            return DOCUMENT_MODE.QUIRKS;
        }
        const { systemId } = token;
        if (systemId && systemId.toLowerCase() === QUIRKS_MODE_SYSTEM_ID) {
            return DOCUMENT_MODE.QUIRKS;
        }
        let { publicId } = token;
        if (publicId !== null) {
            publicId = publicId.toLowerCase();
            if (QUIRKS_MODE_PUBLIC_IDS.has(publicId)) {
                return DOCUMENT_MODE.QUIRKS;
            }
            let prefixes = systemId === null ? QUIRKS_MODE_NO_SYSTEM_ID_PUBLIC_ID_PREFIXES : QUIRKS_MODE_PUBLIC_ID_PREFIXES;
            if (hasPrefix(publicId, prefixes)) {
                return DOCUMENT_MODE.QUIRKS;
            }
            prefixes =
                systemId === null ? LIMITED_QUIRKS_PUBLIC_ID_PREFIXES : LIMITED_QUIRKS_WITH_SYSTEM_ID_PUBLIC_ID_PREFIXES;
            if (hasPrefix(publicId, prefixes)) {
                return DOCUMENT_MODE.LIMITED_QUIRKS;
            }
        }
        return DOCUMENT_MODE.NO_QUIRKS;
    }

    //MIME types
    const MIME_TYPES = {
        TEXT_HTML: 'text/html',
        APPLICATION_XML: 'application/xhtml+xml',
    };
    //Attributes
    const DEFINITION_URL_ATTR = 'definitionurl';
    const ADJUSTED_DEFINITION_URL_ATTR = 'definitionURL';
    const SVG_ATTRS_ADJUSTMENT_MAP = new Map([
        'attributeName',
        'attributeType',
        'baseFrequency',
        'baseProfile',
        'calcMode',
        'clipPathUnits',
        'diffuseConstant',
        'edgeMode',
        'filterUnits',
        'glyphRef',
        'gradientTransform',
        'gradientUnits',
        'kernelMatrix',
        'kernelUnitLength',
        'keyPoints',
        'keySplines',
        'keyTimes',
        'lengthAdjust',
        'limitingConeAngle',
        'markerHeight',
        'markerUnits',
        'markerWidth',
        'maskContentUnits',
        'maskUnits',
        'numOctaves',
        'pathLength',
        'patternContentUnits',
        'patternTransform',
        'patternUnits',
        'pointsAtX',
        'pointsAtY',
        'pointsAtZ',
        'preserveAlpha',
        'preserveAspectRatio',
        'primitiveUnits',
        'refX',
        'refY',
        'repeatCount',
        'repeatDur',
        'requiredExtensions',
        'requiredFeatures',
        'specularConstant',
        'specularExponent',
        'spreadMethod',
        'startOffset',
        'stdDeviation',
        'stitchTiles',
        'surfaceScale',
        'systemLanguage',
        'tableValues',
        'targetX',
        'targetY',
        'textLength',
        'viewBox',
        'viewTarget',
        'xChannelSelector',
        'yChannelSelector',
        'zoomAndPan',
    ].map((attr) => [attr.toLowerCase(), attr]));
    const XML_ATTRS_ADJUSTMENT_MAP = new Map([
        ['xlink:actuate', { prefix: 'xlink', name: 'actuate', namespace: NS.XLINK }],
        ['xlink:arcrole', { prefix: 'xlink', name: 'arcrole', namespace: NS.XLINK }],
        ['xlink:href', { prefix: 'xlink', name: 'href', namespace: NS.XLINK }],
        ['xlink:role', { prefix: 'xlink', name: 'role', namespace: NS.XLINK }],
        ['xlink:show', { prefix: 'xlink', name: 'show', namespace: NS.XLINK }],
        ['xlink:title', { prefix: 'xlink', name: 'title', namespace: NS.XLINK }],
        ['xlink:type', { prefix: 'xlink', name: 'type', namespace: NS.XLINK }],
        ['xml:base', { prefix: 'xml', name: 'base', namespace: NS.XML }],
        ['xml:lang', { prefix: 'xml', name: 'lang', namespace: NS.XML }],
        ['xml:space', { prefix: 'xml', name: 'space', namespace: NS.XML }],
        ['xmlns', { prefix: '', name: 'xmlns', namespace: NS.XMLNS }],
        ['xmlns:xlink', { prefix: 'xmlns', name: 'xlink', namespace: NS.XMLNS }],
    ]);
    //SVG tag names adjustment map
    const SVG_TAG_NAMES_ADJUSTMENT_MAP = new Map([
        'altGlyph',
        'altGlyphDef',
        'altGlyphItem',
        'animateColor',
        'animateMotion',
        'animateTransform',
        'clipPath',
        'feBlend',
        'feColorMatrix',
        'feComponentTransfer',
        'feComposite',
        'feConvolveMatrix',
        'feDiffuseLighting',
        'feDisplacementMap',
        'feDistantLight',
        'feFlood',
        'feFuncA',
        'feFuncB',
        'feFuncG',
        'feFuncR',
        'feGaussianBlur',
        'feImage',
        'feMerge',
        'feMergeNode',
        'feMorphology',
        'feOffset',
        'fePointLight',
        'feSpecularLighting',
        'feSpotLight',
        'feTile',
        'feTurbulence',
        'foreignObject',
        'glyphRef',
        'linearGradient',
        'radialGradient',
        'textPath',
    ].map((tn) => [tn.toLowerCase(), tn]));
    //Tags that causes exit from foreign content
    const EXITS_FOREIGN_CONTENT = new Set([
        TAG_ID.B,
        TAG_ID.BIG,
        TAG_ID.BLOCKQUOTE,
        TAG_ID.BODY,
        TAG_ID.BR,
        TAG_ID.CENTER,
        TAG_ID.CODE,
        TAG_ID.DD,
        TAG_ID.DIV,
        TAG_ID.DL,
        TAG_ID.DT,
        TAG_ID.EM,
        TAG_ID.EMBED,
        TAG_ID.H1,
        TAG_ID.H2,
        TAG_ID.H3,
        TAG_ID.H4,
        TAG_ID.H5,
        TAG_ID.H6,
        TAG_ID.HEAD,
        TAG_ID.HR,
        TAG_ID.I,
        TAG_ID.IMG,
        TAG_ID.LI,
        TAG_ID.LISTING,
        TAG_ID.MENU,
        TAG_ID.META,
        TAG_ID.NOBR,
        TAG_ID.OL,
        TAG_ID.P,
        TAG_ID.PRE,
        TAG_ID.RUBY,
        TAG_ID.S,
        TAG_ID.SMALL,
        TAG_ID.SPAN,
        TAG_ID.STRONG,
        TAG_ID.STRIKE,
        TAG_ID.SUB,
        TAG_ID.SUP,
        TAG_ID.TABLE,
        TAG_ID.TT,
        TAG_ID.U,
        TAG_ID.UL,
        TAG_ID.VAR,
    ]);
    //Check exit from foreign content
    function causesExit(startTagToken) {
        const tn = startTagToken.tagID;
        const isFontWithAttrs = tn === TAG_ID.FONT &&
            startTagToken.attrs.some(({ name }) => name === ATTRS.COLOR || name === ATTRS.SIZE || name === ATTRS.FACE);
        return isFontWithAttrs || EXITS_FOREIGN_CONTENT.has(tn);
    }
    //Token adjustments
    function adjustTokenMathMLAttrs(token) {
        for (let i = 0; i < token.attrs.length; i++) {
            if (token.attrs[i].name === DEFINITION_URL_ATTR) {
                token.attrs[i].name = ADJUSTED_DEFINITION_URL_ATTR;
                break;
            }
        }
    }
    function adjustTokenSVGAttrs(token) {
        for (let i = 0; i < token.attrs.length; i++) {
            const adjustedAttrName = SVG_ATTRS_ADJUSTMENT_MAP.get(token.attrs[i].name);
            if (adjustedAttrName != null) {
                token.attrs[i].name = adjustedAttrName;
            }
        }
    }
    function adjustTokenXMLAttrs(token) {
        for (let i = 0; i < token.attrs.length; i++) {
            const adjustedAttrEntry = XML_ATTRS_ADJUSTMENT_MAP.get(token.attrs[i].name);
            if (adjustedAttrEntry) {
                token.attrs[i].prefix = adjustedAttrEntry.prefix;
                token.attrs[i].name = adjustedAttrEntry.name;
                token.attrs[i].namespace = adjustedAttrEntry.namespace;
            }
        }
    }
    function adjustTokenSVGTagName(token) {
        const adjustedTagName = SVG_TAG_NAMES_ADJUSTMENT_MAP.get(token.tagName);
        if (adjustedTagName != null) {
            token.tagName = adjustedTagName;
            token.tagID = getTagID(token.tagName);
        }
    }
    //Integration points
    function isMathMLTextIntegrationPoint(tn, ns) {
        return ns === NS.MATHML && (tn === TAG_ID.MI || tn === TAG_ID.MO || tn === TAG_ID.MN || tn === TAG_ID.MS || tn === TAG_ID.MTEXT);
    }
    function isHtmlIntegrationPoint(tn, ns, attrs) {
        if (ns === NS.MATHML && tn === TAG_ID.ANNOTATION_XML) {
            for (let i = 0; i < attrs.length; i++) {
                if (attrs[i].name === ATTRS.ENCODING) {
                    const value = attrs[i].value.toLowerCase();
                    return value === MIME_TYPES.TEXT_HTML || value === MIME_TYPES.APPLICATION_XML;
                }
            }
        }
        return ns === NS.SVG && (tn === TAG_ID.FOREIGN_OBJECT || tn === TAG_ID.DESC || tn === TAG_ID.TITLE);
    }
    function isIntegrationPoint(tn, ns, attrs, foreignNS) {
        return (((!foreignNS || foreignNS === NS.HTML) && isHtmlIntegrationPoint(tn, ns, attrs)) ||
            ((!foreignNS || foreignNS === NS.MATHML) && isMathMLTextIntegrationPoint(tn, ns)));
    }

    //Misc constants
    const HIDDEN_INPUT_TYPE = 'hidden';
    //Adoption agency loops iteration count
    const AA_OUTER_LOOP_ITER = 8;
    const AA_INNER_LOOP_ITER = 3;
    //Insertion modes
    var InsertionMode;
    (function (InsertionMode) {
        InsertionMode[InsertionMode["INITIAL"] = 0] = "INITIAL";
        InsertionMode[InsertionMode["BEFORE_HTML"] = 1] = "BEFORE_HTML";
        InsertionMode[InsertionMode["BEFORE_HEAD"] = 2] = "BEFORE_HEAD";
        InsertionMode[InsertionMode["IN_HEAD"] = 3] = "IN_HEAD";
        InsertionMode[InsertionMode["IN_HEAD_NO_SCRIPT"] = 4] = "IN_HEAD_NO_SCRIPT";
        InsertionMode[InsertionMode["AFTER_HEAD"] = 5] = "AFTER_HEAD";
        InsertionMode[InsertionMode["IN_BODY"] = 6] = "IN_BODY";
        InsertionMode[InsertionMode["TEXT"] = 7] = "TEXT";
        InsertionMode[InsertionMode["IN_TABLE"] = 8] = "IN_TABLE";
        InsertionMode[InsertionMode["IN_TABLE_TEXT"] = 9] = "IN_TABLE_TEXT";
        InsertionMode[InsertionMode["IN_CAPTION"] = 10] = "IN_CAPTION";
        InsertionMode[InsertionMode["IN_COLUMN_GROUP"] = 11] = "IN_COLUMN_GROUP";
        InsertionMode[InsertionMode["IN_TABLE_BODY"] = 12] = "IN_TABLE_BODY";
        InsertionMode[InsertionMode["IN_ROW"] = 13] = "IN_ROW";
        InsertionMode[InsertionMode["IN_CELL"] = 14] = "IN_CELL";
        InsertionMode[InsertionMode["IN_SELECT"] = 15] = "IN_SELECT";
        InsertionMode[InsertionMode["IN_SELECT_IN_TABLE"] = 16] = "IN_SELECT_IN_TABLE";
        InsertionMode[InsertionMode["IN_TEMPLATE"] = 17] = "IN_TEMPLATE";
        InsertionMode[InsertionMode["AFTER_BODY"] = 18] = "AFTER_BODY";
        InsertionMode[InsertionMode["IN_FRAMESET"] = 19] = "IN_FRAMESET";
        InsertionMode[InsertionMode["AFTER_FRAMESET"] = 20] = "AFTER_FRAMESET";
        InsertionMode[InsertionMode["AFTER_AFTER_BODY"] = 21] = "AFTER_AFTER_BODY";
        InsertionMode[InsertionMode["AFTER_AFTER_FRAMESET"] = 22] = "AFTER_AFTER_FRAMESET";
    })(InsertionMode || (InsertionMode = {}));
    const BASE_LOC = {
        startLine: -1,
        startCol: -1,
        startOffset: -1,
        endLine: -1,
        endCol: -1,
        endOffset: -1,
    };
    const TABLE_STRUCTURE_TAGS = new Set([TAG_ID.TABLE, TAG_ID.TBODY, TAG_ID.TFOOT, TAG_ID.THEAD, TAG_ID.TR]);
    const defaultParserOptions = {
        scriptingEnabled: true,
        sourceCodeLocationInfo: false,
        treeAdapter: defaultTreeAdapter,
        onParseError: null,
    };
    //Parser
    class Parser$1 {
        constructor(options, document, fragmentContext = null, scriptHandler = null) {
            this.fragmentContext = fragmentContext;
            this.scriptHandler = scriptHandler;
            this.currentToken = null;
            this.stopped = false;
            this.insertionMode = InsertionMode.INITIAL;
            this.originalInsertionMode = InsertionMode.INITIAL;
            this.headElement = null;
            this.formElement = null;
            /** Indicates that the current node is not an element in the HTML namespace */
            this.currentNotInHTML = false;
            /**
             * The template insertion mode stack is maintained from the left.
             * Ie. the topmost element will always have index 0.
             */
            this.tmplInsertionModeStack = [];
            this.pendingCharacterTokens = [];
            this.hasNonWhitespacePendingCharacterToken = false;
            this.framesetOk = true;
            this.skipNextNewLine = false;
            this.fosterParentingEnabled = false;
            this.options = {
                ...defaultParserOptions,
                ...options,
            };
            this.treeAdapter = this.options.treeAdapter;
            this.onParseError = this.options.onParseError;
            // Always enable location info if we report parse errors.
            if (this.onParseError) {
                this.options.sourceCodeLocationInfo = true;
            }
            this.document = document !== null && document !== void 0 ? document : this.treeAdapter.createDocument();
            this.tokenizer = new Tokenizer$1(this.options, this);
            this.activeFormattingElements = new FormattingElementList(this.treeAdapter);
            this.fragmentContextID = fragmentContext ? getTagID(this.treeAdapter.getTagName(fragmentContext)) : TAG_ID.UNKNOWN;
            this._setContextModes(fragmentContext !== null && fragmentContext !== void 0 ? fragmentContext : this.document, this.fragmentContextID);
            this.openElements = new OpenElementStack(this.document, this.treeAdapter, this);
        }
        // API
        static parse(html, options) {
            const parser = new this(options);
            parser.tokenizer.write(html, true);
            return parser.document;
        }
        static getFragmentParser(fragmentContext, options) {
            const opts = {
                ...defaultParserOptions,
                ...options,
            };
            //NOTE: use a <template> element as the fragment context if no context element was provided,
            //so we will parse in a "forgiving" manner
            fragmentContext !== null && fragmentContext !== void 0 ? fragmentContext : (fragmentContext = opts.treeAdapter.createElement(TAG_NAMES.TEMPLATE, NS.HTML, []));
            //NOTE: create a fake element which will be used as the `document` for fragment parsing.
            //This is important for jsdom, where a new `document` cannot be created. This led to
            //fragment parsing messing with the main `document`.
            const documentMock = opts.treeAdapter.createElement('documentmock', NS.HTML, []);
            const parser = new this(opts, documentMock, fragmentContext);
            if (parser.fragmentContextID === TAG_ID.TEMPLATE) {
                parser.tmplInsertionModeStack.unshift(InsertionMode.IN_TEMPLATE);
            }
            parser._initTokenizerForFragmentParsing();
            parser._insertFakeRootElement();
            parser._resetInsertionMode();
            parser._findFormInFragmentContext();
            return parser;
        }
        getFragment() {
            const rootElement = this.treeAdapter.getFirstChild(this.document);
            const fragment = this.treeAdapter.createDocumentFragment();
            this._adoptNodes(rootElement, fragment);
            return fragment;
        }
        //Errors
        _err(token, code, beforeToken) {
            var _a;
            if (!this.onParseError)
                return;
            const loc = (_a = token.location) !== null && _a !== void 0 ? _a : BASE_LOC;
            const err = {
                code,
                startLine: loc.startLine,
                startCol: loc.startCol,
                startOffset: loc.startOffset,
                endLine: beforeToken ? loc.startLine : loc.endLine,
                endCol: beforeToken ? loc.startCol : loc.endCol,
                endOffset: beforeToken ? loc.startOffset : loc.endOffset,
            };
            this.onParseError(err);
        }
        //Stack events
        onItemPush(node, tid, isTop) {
            var _a, _b;
            (_b = (_a = this.treeAdapter).onItemPush) === null || _b === void 0 ? void 0 : _b.call(_a, node);
            if (isTop && this.openElements.stackTop > 0)
                this._setContextModes(node, tid);
        }
        onItemPop(node, isTop) {
            var _a, _b;
            if (this.options.sourceCodeLocationInfo) {
                this._setEndLocation(node, this.currentToken);
            }
            (_b = (_a = this.treeAdapter).onItemPop) === null || _b === void 0 ? void 0 : _b.call(_a, node, this.openElements.current);
            if (isTop) {
                let current;
                let currentTagId;
                if (this.openElements.stackTop === 0 && this.fragmentContext) {
                    current = this.fragmentContext;
                    currentTagId = this.fragmentContextID;
                }
                else {
                    ({ current, currentTagId } = this.openElements);
                }
                this._setContextModes(current, currentTagId);
            }
        }
        _setContextModes(current, tid) {
            const isHTML = current === this.document || this.treeAdapter.getNamespaceURI(current) === NS.HTML;
            this.currentNotInHTML = !isHTML;
            this.tokenizer.inForeignNode = !isHTML && !this._isIntegrationPoint(tid, current);
        }
        _switchToTextParsing(currentToken, nextTokenizerState) {
            this._insertElement(currentToken, NS.HTML);
            this.tokenizer.state = nextTokenizerState;
            this.originalInsertionMode = this.insertionMode;
            this.insertionMode = InsertionMode.TEXT;
        }
        switchToPlaintextParsing() {
            this.insertionMode = InsertionMode.TEXT;
            this.originalInsertionMode = InsertionMode.IN_BODY;
            this.tokenizer.state = TokenizerMode.PLAINTEXT;
        }
        //Fragment parsing
        _getAdjustedCurrentElement() {
            return this.openElements.stackTop === 0 && this.fragmentContext
                ? this.fragmentContext
                : this.openElements.current;
        }
        _findFormInFragmentContext() {
            let node = this.fragmentContext;
            while (node) {
                if (this.treeAdapter.getTagName(node) === TAG_NAMES.FORM) {
                    this.formElement = node;
                    break;
                }
                node = this.treeAdapter.getParentNode(node);
            }
        }
        _initTokenizerForFragmentParsing() {
            if (!this.fragmentContext || this.treeAdapter.getNamespaceURI(this.fragmentContext) !== NS.HTML) {
                return;
            }
            switch (this.fragmentContextID) {
                case TAG_ID.TITLE:
                case TAG_ID.TEXTAREA: {
                    this.tokenizer.state = TokenizerMode.RCDATA;
                    break;
                }
                case TAG_ID.STYLE:
                case TAG_ID.XMP:
                case TAG_ID.IFRAME:
                case TAG_ID.NOEMBED:
                case TAG_ID.NOFRAMES:
                case TAG_ID.NOSCRIPT: {
                    this.tokenizer.state = TokenizerMode.RAWTEXT;
                    break;
                }
                case TAG_ID.SCRIPT: {
                    this.tokenizer.state = TokenizerMode.SCRIPT_DATA;
                    break;
                }
                case TAG_ID.PLAINTEXT: {
                    this.tokenizer.state = TokenizerMode.PLAINTEXT;
                    break;
                }
                // Do nothing
            }
        }
        //Tree mutation
        _setDocumentType(token) {
            const name = token.name || '';
            const publicId = token.publicId || '';
            const systemId = token.systemId || '';
            this.treeAdapter.setDocumentType(this.document, name, publicId, systemId);
            if (token.location) {
                const documentChildren = this.treeAdapter.getChildNodes(this.document);
                const docTypeNode = documentChildren.find((node) => this.treeAdapter.isDocumentTypeNode(node));
                if (docTypeNode) {
                    this.treeAdapter.setNodeSourceCodeLocation(docTypeNode, token.location);
                }
            }
        }
        _attachElementToTree(element, location) {
            if (this.options.sourceCodeLocationInfo) {
                const loc = location && {
                    ...location,
                    startTag: location,
                };
                this.treeAdapter.setNodeSourceCodeLocation(element, loc);
            }
            if (this._shouldFosterParentOnInsertion()) {
                this._fosterParentElement(element);
            }
            else {
                const parent = this.openElements.currentTmplContentOrNode;
                this.treeAdapter.appendChild(parent, element);
            }
        }
        _appendElement(token, namespaceURI) {
            const element = this.treeAdapter.createElement(token.tagName, namespaceURI, token.attrs);
            this._attachElementToTree(element, token.location);
        }
        _insertElement(token, namespaceURI) {
            const element = this.treeAdapter.createElement(token.tagName, namespaceURI, token.attrs);
            this._attachElementToTree(element, token.location);
            this.openElements.push(element, token.tagID);
        }
        _insertFakeElement(tagName, tagID) {
            const element = this.treeAdapter.createElement(tagName, NS.HTML, []);
            this._attachElementToTree(element, null);
            this.openElements.push(element, tagID);
        }
        _insertTemplate(token) {
            const tmpl = this.treeAdapter.createElement(token.tagName, NS.HTML, token.attrs);
            const content = this.treeAdapter.createDocumentFragment();
            this.treeAdapter.setTemplateContent(tmpl, content);
            this._attachElementToTree(tmpl, token.location);
            this.openElements.push(tmpl, token.tagID);
            if (this.options.sourceCodeLocationInfo)
                this.treeAdapter.setNodeSourceCodeLocation(content, null);
        }
        _insertFakeRootElement() {
            const element = this.treeAdapter.createElement(TAG_NAMES.HTML, NS.HTML, []);
            if (this.options.sourceCodeLocationInfo)
                this.treeAdapter.setNodeSourceCodeLocation(element, null);
            this.treeAdapter.appendChild(this.openElements.current, element);
            this.openElements.push(element, TAG_ID.HTML);
        }
        _appendCommentNode(token, parent) {
            const commentNode = this.treeAdapter.createCommentNode(token.data);
            this.treeAdapter.appendChild(parent, commentNode);
            if (this.options.sourceCodeLocationInfo) {
                this.treeAdapter.setNodeSourceCodeLocation(commentNode, token.location);
            }
        }
        _insertCharacters(token) {
            let parent;
            let beforeElement;
            if (this._shouldFosterParentOnInsertion()) {
                ({ parent, beforeElement } = this._findFosterParentingLocation());
                if (beforeElement) {
                    this.treeAdapter.insertTextBefore(parent, token.chars, beforeElement);
                }
                else {
                    this.treeAdapter.insertText(parent, token.chars);
                }
            }
            else {
                parent = this.openElements.currentTmplContentOrNode;
                this.treeAdapter.insertText(parent, token.chars);
            }
            if (!token.location)
                return;
            const siblings = this.treeAdapter.getChildNodes(parent);
            const textNodeIdx = beforeElement ? siblings.lastIndexOf(beforeElement) : siblings.length;
            const textNode = siblings[textNodeIdx - 1];
            //NOTE: if we have a location assigned by another token, then just update the end position
            const tnLoc = this.treeAdapter.getNodeSourceCodeLocation(textNode);
            if (tnLoc) {
                const { endLine, endCol, endOffset } = token.location;
                this.treeAdapter.updateNodeSourceCodeLocation(textNode, { endLine, endCol, endOffset });
            }
            else if (this.options.sourceCodeLocationInfo) {
                this.treeAdapter.setNodeSourceCodeLocation(textNode, token.location);
            }
        }
        _adoptNodes(donor, recipient) {
            for (let child = this.treeAdapter.getFirstChild(donor); child; child = this.treeAdapter.getFirstChild(donor)) {
                this.treeAdapter.detachNode(child);
                this.treeAdapter.appendChild(recipient, child);
            }
        }
        _setEndLocation(element, closingToken) {
            if (this.treeAdapter.getNodeSourceCodeLocation(element) && closingToken.location) {
                const ctLoc = closingToken.location;
                const tn = this.treeAdapter.getTagName(element);
                const endLoc = 
                // NOTE: For cases like <p> <p> </p> - First 'p' closes without a closing
                // tag and for cases like <td> <p> </td> - 'p' closes without a closing tag.
                closingToken.type === TokenType.END_TAG && tn === closingToken.tagName
                    ? {
                        endTag: { ...ctLoc },
                        endLine: ctLoc.endLine,
                        endCol: ctLoc.endCol,
                        endOffset: ctLoc.endOffset,
                    }
                    : {
                        endLine: ctLoc.startLine,
                        endCol: ctLoc.startCol,
                        endOffset: ctLoc.startOffset,
                    };
                this.treeAdapter.updateNodeSourceCodeLocation(element, endLoc);
            }
        }
        //Token processing
        shouldProcessStartTagTokenInForeignContent(token) {
            // Check that neither current === document, or ns === NS.HTML
            if (!this.currentNotInHTML)
                return false;
            let current;
            let currentTagId;
            if (this.openElements.stackTop === 0 && this.fragmentContext) {
                current = this.fragmentContext;
                currentTagId = this.fragmentContextID;
            }
            else {
                ({ current, currentTagId } = this.openElements);
            }
            if (token.tagID === TAG_ID.SVG &&
                this.treeAdapter.getTagName(current) === TAG_NAMES.ANNOTATION_XML &&
                this.treeAdapter.getNamespaceURI(current) === NS.MATHML) {
                return false;
            }
            return (
            // Check that `current` is not an integration point for HTML or MathML elements.
            this.tokenizer.inForeignNode ||
                // If it _is_ an integration point, then we might have to check that it is not an HTML
                // integration point.
                ((token.tagID === TAG_ID.MGLYPH || token.tagID === TAG_ID.MALIGNMARK) &&
                    !this._isIntegrationPoint(currentTagId, current, NS.HTML)));
        }
        _processToken(token) {
            switch (token.type) {
                case TokenType.CHARACTER: {
                    this.onCharacter(token);
                    break;
                }
                case TokenType.NULL_CHARACTER: {
                    this.onNullCharacter(token);
                    break;
                }
                case TokenType.COMMENT: {
                    this.onComment(token);
                    break;
                }
                case TokenType.DOCTYPE: {
                    this.onDoctype(token);
                    break;
                }
                case TokenType.START_TAG: {
                    this._processStartTag(token);
                    break;
                }
                case TokenType.END_TAG: {
                    this.onEndTag(token);
                    break;
                }
                case TokenType.EOF: {
                    this.onEof(token);
                    break;
                }
                case TokenType.WHITESPACE_CHARACTER: {
                    this.onWhitespaceCharacter(token);
                    break;
                }
            }
        }
        //Integration points
        _isIntegrationPoint(tid, element, foreignNS) {
            const ns = this.treeAdapter.getNamespaceURI(element);
            const attrs = this.treeAdapter.getAttrList(element);
            return isIntegrationPoint(tid, ns, attrs, foreignNS);
        }
        //Active formatting elements reconstruction
        _reconstructActiveFormattingElements() {
            const listLength = this.activeFormattingElements.entries.length;
            if (listLength) {
                const endIndex = this.activeFormattingElements.entries.findIndex((entry) => entry.type === EntryType.Marker || this.openElements.contains(entry.element));
                const unopenIdx = endIndex < 0 ? listLength - 1 : endIndex - 1;
                for (let i = unopenIdx; i >= 0; i--) {
                    const entry = this.activeFormattingElements.entries[i];
                    this._insertElement(entry.token, this.treeAdapter.getNamespaceURI(entry.element));
                    entry.element = this.openElements.current;
                }
            }
        }
        //Close elements
        _closeTableCell() {
            this.openElements.generateImpliedEndTags();
            this.openElements.popUntilTableCellPopped();
            this.activeFormattingElements.clearToLastMarker();
            this.insertionMode = InsertionMode.IN_ROW;
        }
        _closePElement() {
            this.openElements.generateImpliedEndTagsWithExclusion(TAG_ID.P);
            this.openElements.popUntilTagNamePopped(TAG_ID.P);
        }
        //Insertion modes
        _resetInsertionMode() {
            for (let i = this.openElements.stackTop; i >= 0; i--) {
                //Insertion mode reset map
                switch (i === 0 && this.fragmentContext ? this.fragmentContextID : this.openElements.tagIDs[i]) {
                    case TAG_ID.TR:
                        this.insertionMode = InsertionMode.IN_ROW;
                        return;
                    case TAG_ID.TBODY:
                    case TAG_ID.THEAD:
                    case TAG_ID.TFOOT:
                        this.insertionMode = InsertionMode.IN_TABLE_BODY;
                        return;
                    case TAG_ID.CAPTION:
                        this.insertionMode = InsertionMode.IN_CAPTION;
                        return;
                    case TAG_ID.COLGROUP:
                        this.insertionMode = InsertionMode.IN_COLUMN_GROUP;
                        return;
                    case TAG_ID.TABLE:
                        this.insertionMode = InsertionMode.IN_TABLE;
                        return;
                    case TAG_ID.BODY:
                        this.insertionMode = InsertionMode.IN_BODY;
                        return;
                    case TAG_ID.FRAMESET:
                        this.insertionMode = InsertionMode.IN_FRAMESET;
                        return;
                    case TAG_ID.SELECT:
                        this._resetInsertionModeForSelect(i);
                        return;
                    case TAG_ID.TEMPLATE:
                        this.insertionMode = this.tmplInsertionModeStack[0];
                        return;
                    case TAG_ID.HTML:
                        this.insertionMode = this.headElement ? InsertionMode.AFTER_HEAD : InsertionMode.BEFORE_HEAD;
                        return;
                    case TAG_ID.TD:
                    case TAG_ID.TH:
                        if (i > 0) {
                            this.insertionMode = InsertionMode.IN_CELL;
                            return;
                        }
                        break;
                    case TAG_ID.HEAD:
                        if (i > 0) {
                            this.insertionMode = InsertionMode.IN_HEAD;
                            return;
                        }
                        break;
                }
            }
            this.insertionMode = InsertionMode.IN_BODY;
        }
        _resetInsertionModeForSelect(selectIdx) {
            if (selectIdx > 0) {
                for (let i = selectIdx - 1; i > 0; i--) {
                    const tn = this.openElements.tagIDs[i];
                    if (tn === TAG_ID.TEMPLATE) {
                        break;
                    }
                    else if (tn === TAG_ID.TABLE) {
                        this.insertionMode = InsertionMode.IN_SELECT_IN_TABLE;
                        return;
                    }
                }
            }
            this.insertionMode = InsertionMode.IN_SELECT;
        }
        //Foster parenting
        _isElementCausesFosterParenting(tn) {
            return TABLE_STRUCTURE_TAGS.has(tn);
        }
        _shouldFosterParentOnInsertion() {
            return this.fosterParentingEnabled && this._isElementCausesFosterParenting(this.openElements.currentTagId);
        }
        _findFosterParentingLocation() {
            for (let i = this.openElements.stackTop; i >= 0; i--) {
                const openElement = this.openElements.items[i];
                switch (this.openElements.tagIDs[i]) {
                    case TAG_ID.TEMPLATE:
                        if (this.treeAdapter.getNamespaceURI(openElement) === NS.HTML) {
                            return { parent: this.treeAdapter.getTemplateContent(openElement), beforeElement: null };
                        }
                        break;
                    case TAG_ID.TABLE: {
                        const parent = this.treeAdapter.getParentNode(openElement);
                        if (parent) {
                            return { parent, beforeElement: openElement };
                        }
                        return { parent: this.openElements.items[i - 1], beforeElement: null };
                    }
                    // Do nothing
                }
            }
            return { parent: this.openElements.items[0], beforeElement: null };
        }
        _fosterParentElement(element) {
            const location = this._findFosterParentingLocation();
            if (location.beforeElement) {
                this.treeAdapter.insertBefore(location.parent, element, location.beforeElement);
            }
            else {
                this.treeAdapter.appendChild(location.parent, element);
            }
        }
        //Special elements
        _isSpecialElement(element, id) {
            const ns = this.treeAdapter.getNamespaceURI(element);
            return SPECIAL_ELEMENTS[ns].has(id);
        }
        onCharacter(token) {
            this.skipNextNewLine = false;
            if (this.tokenizer.inForeignNode) {
                characterInForeignContent(this, token);
                return;
            }
            switch (this.insertionMode) {
                case InsertionMode.INITIAL:
                    tokenInInitialMode(this, token);
                    break;
                case InsertionMode.BEFORE_HTML:
                    tokenBeforeHtml(this, token);
                    break;
                case InsertionMode.BEFORE_HEAD:
                    tokenBeforeHead(this, token);
                    break;
                case InsertionMode.IN_HEAD:
                    tokenInHead(this, token);
                    break;
                case InsertionMode.IN_HEAD_NO_SCRIPT:
                    tokenInHeadNoScript(this, token);
                    break;
                case InsertionMode.AFTER_HEAD:
                    tokenAfterHead(this, token);
                    break;
                case InsertionMode.IN_BODY:
                case InsertionMode.IN_CAPTION:
                case InsertionMode.IN_CELL:
                case InsertionMode.IN_TEMPLATE:
                    characterInBody(this, token);
                    break;
                case InsertionMode.TEXT:
                case InsertionMode.IN_SELECT:
                case InsertionMode.IN_SELECT_IN_TABLE:
                    this._insertCharacters(token);
                    break;
                case InsertionMode.IN_TABLE:
                case InsertionMode.IN_TABLE_BODY:
                case InsertionMode.IN_ROW:
                    characterInTable(this, token);
                    break;
                case InsertionMode.IN_TABLE_TEXT:
                    characterInTableText(this, token);
                    break;
                case InsertionMode.IN_COLUMN_GROUP:
                    tokenInColumnGroup(this, token);
                    break;
                case InsertionMode.AFTER_BODY:
                    tokenAfterBody(this, token);
                    break;
                case InsertionMode.AFTER_AFTER_BODY:
                    tokenAfterAfterBody(this, token);
                    break;
                // Do nothing
            }
        }
        onNullCharacter(token) {
            this.skipNextNewLine = false;
            if (this.tokenizer.inForeignNode) {
                nullCharacterInForeignContent(this, token);
                return;
            }
            switch (this.insertionMode) {
                case InsertionMode.INITIAL:
                    tokenInInitialMode(this, token);
                    break;
                case InsertionMode.BEFORE_HTML:
                    tokenBeforeHtml(this, token);
                    break;
                case InsertionMode.BEFORE_HEAD:
                    tokenBeforeHead(this, token);
                    break;
                case InsertionMode.IN_HEAD:
                    tokenInHead(this, token);
                    break;
                case InsertionMode.IN_HEAD_NO_SCRIPT:
                    tokenInHeadNoScript(this, token);
                    break;
                case InsertionMode.AFTER_HEAD:
                    tokenAfterHead(this, token);
                    break;
                case InsertionMode.TEXT:
                    this._insertCharacters(token);
                    break;
                case InsertionMode.IN_TABLE:
                case InsertionMode.IN_TABLE_BODY:
                case InsertionMode.IN_ROW:
                    characterInTable(this, token);
                    break;
                case InsertionMode.IN_COLUMN_GROUP:
                    tokenInColumnGroup(this, token);
                    break;
                case InsertionMode.AFTER_BODY:
                    tokenAfterBody(this, token);
                    break;
                case InsertionMode.AFTER_AFTER_BODY:
                    tokenAfterAfterBody(this, token);
                    break;
                // Do nothing
            }
        }
        onComment(token) {
            this.skipNextNewLine = false;
            if (this.currentNotInHTML) {
                appendComment(this, token);
                return;
            }
            switch (this.insertionMode) {
                case InsertionMode.INITIAL:
                case InsertionMode.BEFORE_HTML:
                case InsertionMode.BEFORE_HEAD:
                case InsertionMode.IN_HEAD:
                case InsertionMode.IN_HEAD_NO_SCRIPT:
                case InsertionMode.AFTER_HEAD:
                case InsertionMode.IN_BODY:
                case InsertionMode.IN_TABLE:
                case InsertionMode.IN_CAPTION:
                case InsertionMode.IN_COLUMN_GROUP:
                case InsertionMode.IN_TABLE_BODY:
                case InsertionMode.IN_ROW:
                case InsertionMode.IN_CELL:
                case InsertionMode.IN_SELECT:
                case InsertionMode.IN_SELECT_IN_TABLE:
                case InsertionMode.IN_TEMPLATE:
                case InsertionMode.IN_FRAMESET:
                case InsertionMode.AFTER_FRAMESET:
                    appendComment(this, token);
                    break;
                case InsertionMode.IN_TABLE_TEXT:
                    tokenInTableText(this, token);
                    break;
                case InsertionMode.AFTER_BODY:
                    appendCommentToRootHtmlElement(this, token);
                    break;
                case InsertionMode.AFTER_AFTER_BODY:
                case InsertionMode.AFTER_AFTER_FRAMESET:
                    appendCommentToDocument(this, token);
                    break;
                // Do nothing
            }
        }
        onDoctype(token) {
            this.skipNextNewLine = false;
            switch (this.insertionMode) {
                case InsertionMode.INITIAL:
                    doctypeInInitialMode(this, token);
                    break;
                case InsertionMode.BEFORE_HEAD:
                case InsertionMode.IN_HEAD:
                case InsertionMode.IN_HEAD_NO_SCRIPT:
                case InsertionMode.AFTER_HEAD:
                    this._err(token, ERR.misplacedDoctype);
                    break;
                case InsertionMode.IN_TABLE_TEXT:
                    tokenInTableText(this, token);
                    break;
                // Do nothing
            }
        }
        onStartTag(token) {
            this.skipNextNewLine = false;
            this.currentToken = token;
            this._processStartTag(token);
            if (token.selfClosing && !token.ackSelfClosing) {
                this._err(token, ERR.nonVoidHtmlElementStartTagWithTrailingSolidus);
            }
        }
        /**
         * Processes a given start tag.
         *
         * `onStartTag` checks if a self-closing tag was recognized. When a token
         * is moved inbetween multiple insertion modes, this check for self-closing
         * could lead to false positives. To avoid this, `_processStartTag` is used
         * for nested calls.
         *
         * @param token The token to process.
         */
        _processStartTag(token) {
            if (this.shouldProcessStartTagTokenInForeignContent(token)) {
                startTagInForeignContent(this, token);
            }
            else {
                this._startTagOutsideForeignContent(token);
            }
        }
        _startTagOutsideForeignContent(token) {
            switch (this.insertionMode) {
                case InsertionMode.INITIAL:
                    tokenInInitialMode(this, token);
                    break;
                case InsertionMode.BEFORE_HTML:
                    startTagBeforeHtml(this, token);
                    break;
                case InsertionMode.BEFORE_HEAD:
                    startTagBeforeHead(this, token);
                    break;
                case InsertionMode.IN_HEAD:
                    startTagInHead(this, token);
                    break;
                case InsertionMode.IN_HEAD_NO_SCRIPT:
                    startTagInHeadNoScript(this, token);
                    break;
                case InsertionMode.AFTER_HEAD:
                    startTagAfterHead(this, token);
                    break;
                case InsertionMode.IN_BODY:
                    startTagInBody(this, token);
                    break;
                case InsertionMode.IN_TABLE:
                    startTagInTable(this, token);
                    break;
                case InsertionMode.IN_TABLE_TEXT:
                    tokenInTableText(this, token);
                    break;
                case InsertionMode.IN_CAPTION:
                    startTagInCaption(this, token);
                    break;
                case InsertionMode.IN_COLUMN_GROUP:
                    startTagInColumnGroup(this, token);
                    break;
                case InsertionMode.IN_TABLE_BODY:
                    startTagInTableBody(this, token);
                    break;
                case InsertionMode.IN_ROW:
                    startTagInRow(this, token);
                    break;
                case InsertionMode.IN_CELL:
                    startTagInCell(this, token);
                    break;
                case InsertionMode.IN_SELECT:
                    startTagInSelect(this, token);
                    break;
                case InsertionMode.IN_SELECT_IN_TABLE:
                    startTagInSelectInTable(this, token);
                    break;
                case InsertionMode.IN_TEMPLATE:
                    startTagInTemplate(this, token);
                    break;
                case InsertionMode.AFTER_BODY:
                    startTagAfterBody(this, token);
                    break;
                case InsertionMode.IN_FRAMESET:
                    startTagInFrameset(this, token);
                    break;
                case InsertionMode.AFTER_FRAMESET:
                    startTagAfterFrameset(this, token);
                    break;
                case InsertionMode.AFTER_AFTER_BODY:
                    startTagAfterAfterBody(this, token);
                    break;
                case InsertionMode.AFTER_AFTER_FRAMESET:
                    startTagAfterAfterFrameset(this, token);
                    break;
                // Do nothing
            }
        }
        onEndTag(token) {
            this.skipNextNewLine = false;
            this.currentToken = token;
            if (this.currentNotInHTML) {
                endTagInForeignContent(this, token);
            }
            else {
                this._endTagOutsideForeignContent(token);
            }
        }
        _endTagOutsideForeignContent(token) {
            switch (this.insertionMode) {
                case InsertionMode.INITIAL:
                    tokenInInitialMode(this, token);
                    break;
                case InsertionMode.BEFORE_HTML:
                    endTagBeforeHtml(this, token);
                    break;
                case InsertionMode.BEFORE_HEAD:
                    endTagBeforeHead(this, token);
                    break;
                case InsertionMode.IN_HEAD:
                    endTagInHead(this, token);
                    break;
                case InsertionMode.IN_HEAD_NO_SCRIPT:
                    endTagInHeadNoScript(this, token);
                    break;
                case InsertionMode.AFTER_HEAD:
                    endTagAfterHead(this, token);
                    break;
                case InsertionMode.IN_BODY:
                    endTagInBody(this, token);
                    break;
                case InsertionMode.TEXT:
                    endTagInText(this, token);
                    break;
                case InsertionMode.IN_TABLE:
                    endTagInTable(this, token);
                    break;
                case InsertionMode.IN_TABLE_TEXT:
                    tokenInTableText(this, token);
                    break;
                case InsertionMode.IN_CAPTION:
                    endTagInCaption(this, token);
                    break;
                case InsertionMode.IN_COLUMN_GROUP:
                    endTagInColumnGroup(this, token);
                    break;
                case InsertionMode.IN_TABLE_BODY:
                    endTagInTableBody(this, token);
                    break;
                case InsertionMode.IN_ROW:
                    endTagInRow(this, token);
                    break;
                case InsertionMode.IN_CELL:
                    endTagInCell(this, token);
                    break;
                case InsertionMode.IN_SELECT:
                    endTagInSelect(this, token);
                    break;
                case InsertionMode.IN_SELECT_IN_TABLE:
                    endTagInSelectInTable(this, token);
                    break;
                case InsertionMode.IN_TEMPLATE:
                    endTagInTemplate(this, token);
                    break;
                case InsertionMode.AFTER_BODY:
                    endTagAfterBody(this, token);
                    break;
                case InsertionMode.IN_FRAMESET:
                    endTagInFrameset(this, token);
                    break;
                case InsertionMode.AFTER_FRAMESET:
                    endTagAfterFrameset(this, token);
                    break;
                case InsertionMode.AFTER_AFTER_BODY:
                    tokenAfterAfterBody(this, token);
                    break;
                // Do nothing
            }
        }
        onEof(token) {
            switch (this.insertionMode) {
                case InsertionMode.INITIAL:
                    tokenInInitialMode(this, token);
                    break;
                case InsertionMode.BEFORE_HTML:
                    tokenBeforeHtml(this, token);
                    break;
                case InsertionMode.BEFORE_HEAD:
                    tokenBeforeHead(this, token);
                    break;
                case InsertionMode.IN_HEAD:
                    tokenInHead(this, token);
                    break;
                case InsertionMode.IN_HEAD_NO_SCRIPT:
                    tokenInHeadNoScript(this, token);
                    break;
                case InsertionMode.AFTER_HEAD:
                    tokenAfterHead(this, token);
                    break;
                case InsertionMode.IN_BODY:
                case InsertionMode.IN_TABLE:
                case InsertionMode.IN_CAPTION:
                case InsertionMode.IN_COLUMN_GROUP:
                case InsertionMode.IN_TABLE_BODY:
                case InsertionMode.IN_ROW:
                case InsertionMode.IN_CELL:
                case InsertionMode.IN_SELECT:
                case InsertionMode.IN_SELECT_IN_TABLE:
                    eofInBody(this, token);
                    break;
                case InsertionMode.TEXT:
                    eofInText(this, token);
                    break;
                case InsertionMode.IN_TABLE_TEXT:
                    tokenInTableText(this, token);
                    break;
                case InsertionMode.IN_TEMPLATE:
                    eofInTemplate(this, token);
                    break;
                case InsertionMode.AFTER_BODY:
                case InsertionMode.IN_FRAMESET:
                case InsertionMode.AFTER_FRAMESET:
                case InsertionMode.AFTER_AFTER_BODY:
                case InsertionMode.AFTER_AFTER_FRAMESET:
                    stopParsing(this, token);
                    break;
                // Do nothing
            }
        }
        onWhitespaceCharacter(token) {
            if (this.skipNextNewLine) {
                this.skipNextNewLine = false;
                if (token.chars.charCodeAt(0) === CODE_POINTS.LINE_FEED) {
                    if (token.chars.length === 1) {
                        return;
                    }
                    token.chars = token.chars.substr(1);
                }
            }
            if (this.tokenizer.inForeignNode) {
                this._insertCharacters(token);
                return;
            }
            switch (this.insertionMode) {
                case InsertionMode.IN_HEAD:
                case InsertionMode.IN_HEAD_NO_SCRIPT:
                case InsertionMode.AFTER_HEAD:
                case InsertionMode.TEXT:
                case InsertionMode.IN_COLUMN_GROUP:
                case InsertionMode.IN_SELECT:
                case InsertionMode.IN_SELECT_IN_TABLE:
                case InsertionMode.IN_FRAMESET:
                case InsertionMode.AFTER_FRAMESET:
                    this._insertCharacters(token);
                    break;
                case InsertionMode.IN_BODY:
                case InsertionMode.IN_CAPTION:
                case InsertionMode.IN_CELL:
                case InsertionMode.IN_TEMPLATE:
                case InsertionMode.AFTER_BODY:
                case InsertionMode.AFTER_AFTER_BODY:
                case InsertionMode.AFTER_AFTER_FRAMESET:
                    whitespaceCharacterInBody(this, token);
                    break;
                case InsertionMode.IN_TABLE:
                case InsertionMode.IN_TABLE_BODY:
                case InsertionMode.IN_ROW:
                    characterInTable(this, token);
                    break;
                case InsertionMode.IN_TABLE_TEXT:
                    whitespaceCharacterInTableText(this, token);
                    break;
                // Do nothing
            }
        }
    }
    //Adoption agency algorithm
    //(see: http://www.whatwg.org/specs/web-apps/current-work/multipage/tree-construction.html#adoptionAgency)
    //------------------------------------------------------------------
    //Steps 5-8 of the algorithm
    function aaObtainFormattingElementEntry(p, token) {
        let formattingElementEntry = p.activeFormattingElements.getElementEntryInScopeWithTagName(token.tagName);
        if (formattingElementEntry) {
            if (!p.openElements.contains(formattingElementEntry.element)) {
                p.activeFormattingElements.removeEntry(formattingElementEntry);
                formattingElementEntry = null;
            }
            else if (!p.openElements.hasInScope(token.tagID)) {
                formattingElementEntry = null;
            }
        }
        else {
            genericEndTagInBody(p, token);
        }
        return formattingElementEntry;
    }
    //Steps 9 and 10 of the algorithm
    function aaObtainFurthestBlock(p, formattingElementEntry) {
        let furthestBlock = null;
        let idx = p.openElements.stackTop;
        for (; idx >= 0; idx--) {
            const element = p.openElements.items[idx];
            if (element === formattingElementEntry.element) {
                break;
            }
            if (p._isSpecialElement(element, p.openElements.tagIDs[idx])) {
                furthestBlock = element;
            }
        }
        if (!furthestBlock) {
            p.openElements.shortenToLength(idx < 0 ? 0 : idx);
            p.activeFormattingElements.removeEntry(formattingElementEntry);
        }
        return furthestBlock;
    }
    //Step 13 of the algorithm
    function aaInnerLoop(p, furthestBlock, formattingElement) {
        let lastElement = furthestBlock;
        let nextElement = p.openElements.getCommonAncestor(furthestBlock);
        for (let i = 0, element = nextElement; element !== formattingElement; i++, element = nextElement) {
            //NOTE: store the next element for the next loop iteration (it may be deleted from the stack by step 9.5)
            nextElement = p.openElements.getCommonAncestor(element);
            const elementEntry = p.activeFormattingElements.getElementEntry(element);
            const counterOverflow = elementEntry && i >= AA_INNER_LOOP_ITER;
            const shouldRemoveFromOpenElements = !elementEntry || counterOverflow;
            if (shouldRemoveFromOpenElements) {
                if (counterOverflow) {
                    p.activeFormattingElements.removeEntry(elementEntry);
                }
                p.openElements.remove(element);
            }
            else {
                element = aaRecreateElementFromEntry(p, elementEntry);
                if (lastElement === furthestBlock) {
                    p.activeFormattingElements.bookmark = elementEntry;
                }
                p.treeAdapter.detachNode(lastElement);
                p.treeAdapter.appendChild(element, lastElement);
                lastElement = element;
            }
        }
        return lastElement;
    }
    //Step 13.7 of the algorithm
    function aaRecreateElementFromEntry(p, elementEntry) {
        const ns = p.treeAdapter.getNamespaceURI(elementEntry.element);
        const newElement = p.treeAdapter.createElement(elementEntry.token.tagName, ns, elementEntry.token.attrs);
        p.openElements.replace(elementEntry.element, newElement);
        elementEntry.element = newElement;
        return newElement;
    }
    //Step 14 of the algorithm
    function aaInsertLastNodeInCommonAncestor(p, commonAncestor, lastElement) {
        const tn = p.treeAdapter.getTagName(commonAncestor);
        const tid = getTagID(tn);
        if (p._isElementCausesFosterParenting(tid)) {
            p._fosterParentElement(lastElement);
        }
        else {
            const ns = p.treeAdapter.getNamespaceURI(commonAncestor);
            if (tid === TAG_ID.TEMPLATE && ns === NS.HTML) {
                commonAncestor = p.treeAdapter.getTemplateContent(commonAncestor);
            }
            p.treeAdapter.appendChild(commonAncestor, lastElement);
        }
    }
    //Steps 15-19 of the algorithm
    function aaReplaceFormattingElement(p, furthestBlock, formattingElementEntry) {
        const ns = p.treeAdapter.getNamespaceURI(formattingElementEntry.element);
        const { token } = formattingElementEntry;
        const newElement = p.treeAdapter.createElement(token.tagName, ns, token.attrs);
        p._adoptNodes(furthestBlock, newElement);
        p.treeAdapter.appendChild(furthestBlock, newElement);
        p.activeFormattingElements.insertElementAfterBookmark(newElement, token);
        p.activeFormattingElements.removeEntry(formattingElementEntry);
        p.openElements.remove(formattingElementEntry.element);
        p.openElements.insertAfter(furthestBlock, newElement, token.tagID);
    }
    //Algorithm entry point
    function callAdoptionAgency(p, token) {
        for (let i = 0; i < AA_OUTER_LOOP_ITER; i++) {
            const formattingElementEntry = aaObtainFormattingElementEntry(p, token);
            if (!formattingElementEntry) {
                break;
            }
            const furthestBlock = aaObtainFurthestBlock(p, formattingElementEntry);
            if (!furthestBlock) {
                break;
            }
            p.activeFormattingElements.bookmark = formattingElementEntry;
            const lastElement = aaInnerLoop(p, furthestBlock, formattingElementEntry.element);
            const commonAncestor = p.openElements.getCommonAncestor(formattingElementEntry.element);
            p.treeAdapter.detachNode(lastElement);
            if (commonAncestor)
                aaInsertLastNodeInCommonAncestor(p, commonAncestor, lastElement);
            aaReplaceFormattingElement(p, furthestBlock, formattingElementEntry);
        }
    }
    //Generic token handlers
    //------------------------------------------------------------------
    function appendComment(p, token) {
        p._appendCommentNode(token, p.openElements.currentTmplContentOrNode);
    }
    function appendCommentToRootHtmlElement(p, token) {
        p._appendCommentNode(token, p.openElements.items[0]);
    }
    function appendCommentToDocument(p, token) {
        p._appendCommentNode(token, p.document);
    }
    function stopParsing(p, token) {
        p.stopped = true;
        // NOTE: Set end locations for elements that remain on the open element stack.
        if (token.location) {
            // NOTE: If we are not in a fragment, `html` and `body` will stay on the stack.
            // This is a problem, as we might overwrite their end position here.
            const target = p.fragmentContext ? 0 : 2;
            for (let i = p.openElements.stackTop; i >= target; i--) {
                p._setEndLocation(p.openElements.items[i], token);
            }
            // Handle `html` and `body`
            if (!p.fragmentContext && p.openElements.stackTop >= 0) {
                const htmlElement = p.openElements.items[0];
                const htmlLocation = p.treeAdapter.getNodeSourceCodeLocation(htmlElement);
                if (htmlLocation && !htmlLocation.endTag) {
                    p._setEndLocation(htmlElement, token);
                    if (p.openElements.stackTop >= 1) {
                        const bodyElement = p.openElements.items[1];
                        const bodyLocation = p.treeAdapter.getNodeSourceCodeLocation(bodyElement);
                        if (bodyLocation && !bodyLocation.endTag) {
                            p._setEndLocation(bodyElement, token);
                        }
                    }
                }
            }
        }
    }
    // The "initial" insertion mode
    //------------------------------------------------------------------
    function doctypeInInitialMode(p, token) {
        p._setDocumentType(token);
        const mode = token.forceQuirks ? DOCUMENT_MODE.QUIRKS : getDocumentMode(token);
        if (!isConforming(token)) {
            p._err(token, ERR.nonConformingDoctype);
        }
        p.treeAdapter.setDocumentMode(p.document, mode);
        p.insertionMode = InsertionMode.BEFORE_HTML;
    }
    function tokenInInitialMode(p, token) {
        p._err(token, ERR.missingDoctype, true);
        p.treeAdapter.setDocumentMode(p.document, DOCUMENT_MODE.QUIRKS);
        p.insertionMode = InsertionMode.BEFORE_HTML;
        p._processToken(token);
    }
    // The "before html" insertion mode
    //------------------------------------------------------------------
    function startTagBeforeHtml(p, token) {
        if (token.tagID === TAG_ID.HTML) {
            p._insertElement(token, NS.HTML);
            p.insertionMode = InsertionMode.BEFORE_HEAD;
        }
        else {
            tokenBeforeHtml(p, token);
        }
    }
    function endTagBeforeHtml(p, token) {
        const tn = token.tagID;
        if (tn === TAG_ID.HTML || tn === TAG_ID.HEAD || tn === TAG_ID.BODY || tn === TAG_ID.BR) {
            tokenBeforeHtml(p, token);
        }
    }
    function tokenBeforeHtml(p, token) {
        p._insertFakeRootElement();
        p.insertionMode = InsertionMode.BEFORE_HEAD;
        p._processToken(token);
    }
    // The "before head" insertion mode
    //------------------------------------------------------------------
    function startTagBeforeHead(p, token) {
        switch (token.tagID) {
            case TAG_ID.HTML: {
                startTagInBody(p, token);
                break;
            }
            case TAG_ID.HEAD: {
                p._insertElement(token, NS.HTML);
                p.headElement = p.openElements.current;
                p.insertionMode = InsertionMode.IN_HEAD;
                break;
            }
            default: {
                tokenBeforeHead(p, token);
            }
        }
    }
    function endTagBeforeHead(p, token) {
        const tn = token.tagID;
        if (tn === TAG_ID.HEAD || tn === TAG_ID.BODY || tn === TAG_ID.HTML || tn === TAG_ID.BR) {
            tokenBeforeHead(p, token);
        }
        else {
            p._err(token, ERR.endTagWithoutMatchingOpenElement);
        }
    }
    function tokenBeforeHead(p, token) {
        p._insertFakeElement(TAG_NAMES.HEAD, TAG_ID.HEAD);
        p.headElement = p.openElements.current;
        p.insertionMode = InsertionMode.IN_HEAD;
        p._processToken(token);
    }
    // The "in head" insertion mode
    //------------------------------------------------------------------
    function startTagInHead(p, token) {
        switch (token.tagID) {
            case TAG_ID.HTML: {
                startTagInBody(p, token);
                break;
            }
            case TAG_ID.BASE:
            case TAG_ID.BASEFONT:
            case TAG_ID.BGSOUND:
            case TAG_ID.LINK:
            case TAG_ID.META: {
                p._appendElement(token, NS.HTML);
                token.ackSelfClosing = true;
                break;
            }
            case TAG_ID.TITLE: {
                p._switchToTextParsing(token, TokenizerMode.RCDATA);
                break;
            }
            case TAG_ID.NOSCRIPT: {
                if (p.options.scriptingEnabled) {
                    p._switchToTextParsing(token, TokenizerMode.RAWTEXT);
                }
                else {
                    p._insertElement(token, NS.HTML);
                    p.insertionMode = InsertionMode.IN_HEAD_NO_SCRIPT;
                }
                break;
            }
            case TAG_ID.NOFRAMES:
            case TAG_ID.STYLE: {
                p._switchToTextParsing(token, TokenizerMode.RAWTEXT);
                break;
            }
            case TAG_ID.SCRIPT: {
                p._switchToTextParsing(token, TokenizerMode.SCRIPT_DATA);
                break;
            }
            case TAG_ID.TEMPLATE: {
                p._insertTemplate(token);
                p.activeFormattingElements.insertMarker();
                p.framesetOk = false;
                p.insertionMode = InsertionMode.IN_TEMPLATE;
                p.tmplInsertionModeStack.unshift(InsertionMode.IN_TEMPLATE);
                break;
            }
            case TAG_ID.HEAD: {
                p._err(token, ERR.misplacedStartTagForHeadElement);
                break;
            }
            default: {
                tokenInHead(p, token);
            }
        }
    }
    function endTagInHead(p, token) {
        switch (token.tagID) {
            case TAG_ID.HEAD: {
                p.openElements.pop();
                p.insertionMode = InsertionMode.AFTER_HEAD;
                break;
            }
            case TAG_ID.BODY:
            case TAG_ID.BR:
            case TAG_ID.HTML: {
                tokenInHead(p, token);
                break;
            }
            case TAG_ID.TEMPLATE: {
                if (p.openElements.tmplCount > 0) {
                    p.openElements.generateImpliedEndTagsThoroughly();
                    if (p.openElements.currentTagId !== TAG_ID.TEMPLATE) {
                        p._err(token, ERR.closingOfElementWithOpenChildElements);
                    }
                    p.openElements.popUntilTagNamePopped(TAG_ID.TEMPLATE);
                    p.activeFormattingElements.clearToLastMarker();
                    p.tmplInsertionModeStack.shift();
                    p._resetInsertionMode();
                }
                else {
                    p._err(token, ERR.endTagWithoutMatchingOpenElement);
                }
                break;
            }
            default: {
                p._err(token, ERR.endTagWithoutMatchingOpenElement);
            }
        }
    }
    function tokenInHead(p, token) {
        p.openElements.pop();
        p.insertionMode = InsertionMode.AFTER_HEAD;
        p._processToken(token);
    }
    // The "in head no script" insertion mode
    //------------------------------------------------------------------
    function startTagInHeadNoScript(p, token) {
        switch (token.tagID) {
            case TAG_ID.HTML: {
                startTagInBody(p, token);
                break;
            }
            case TAG_ID.BASEFONT:
            case TAG_ID.BGSOUND:
            case TAG_ID.HEAD:
            case TAG_ID.LINK:
            case TAG_ID.META:
            case TAG_ID.NOFRAMES:
            case TAG_ID.STYLE: {
                startTagInHead(p, token);
                break;
            }
            case TAG_ID.NOSCRIPT: {
                p._err(token, ERR.nestedNoscriptInHead);
                break;
            }
            default: {
                tokenInHeadNoScript(p, token);
            }
        }
    }
    function endTagInHeadNoScript(p, token) {
        switch (token.tagID) {
            case TAG_ID.NOSCRIPT: {
                p.openElements.pop();
                p.insertionMode = InsertionMode.IN_HEAD;
                break;
            }
            case TAG_ID.BR: {
                tokenInHeadNoScript(p, token);
                break;
            }
            default: {
                p._err(token, ERR.endTagWithoutMatchingOpenElement);
            }
        }
    }
    function tokenInHeadNoScript(p, token) {
        const errCode = token.type === TokenType.EOF ? ERR.openElementsLeftAfterEof : ERR.disallowedContentInNoscriptInHead;
        p._err(token, errCode);
        p.openElements.pop();
        p.insertionMode = InsertionMode.IN_HEAD;
        p._processToken(token);
    }
    // The "after head" insertion mode
    //------------------------------------------------------------------
    function startTagAfterHead(p, token) {
        switch (token.tagID) {
            case TAG_ID.HTML: {
                startTagInBody(p, token);
                break;
            }
            case TAG_ID.BODY: {
                p._insertElement(token, NS.HTML);
                p.framesetOk = false;
                p.insertionMode = InsertionMode.IN_BODY;
                break;
            }
            case TAG_ID.FRAMESET: {
                p._insertElement(token, NS.HTML);
                p.insertionMode = InsertionMode.IN_FRAMESET;
                break;
            }
            case TAG_ID.BASE:
            case TAG_ID.BASEFONT:
            case TAG_ID.BGSOUND:
            case TAG_ID.LINK:
            case TAG_ID.META:
            case TAG_ID.NOFRAMES:
            case TAG_ID.SCRIPT:
            case TAG_ID.STYLE:
            case TAG_ID.TEMPLATE:
            case TAG_ID.TITLE: {
                p._err(token, ERR.abandonedHeadElementChild);
                p.openElements.push(p.headElement, TAG_ID.HEAD);
                startTagInHead(p, token);
                p.openElements.remove(p.headElement);
                break;
            }
            case TAG_ID.HEAD: {
                p._err(token, ERR.misplacedStartTagForHeadElement);
                break;
            }
            default: {
                tokenAfterHead(p, token);
            }
        }
    }
    function endTagAfterHead(p, token) {
        switch (token.tagID) {
            case TAG_ID.BODY:
            case TAG_ID.HTML:
            case TAG_ID.BR: {
                tokenAfterHead(p, token);
                break;
            }
            case TAG_ID.TEMPLATE: {
                endTagInHead(p, token);
                break;
            }
            default: {
                p._err(token, ERR.endTagWithoutMatchingOpenElement);
            }
        }
    }
    function tokenAfterHead(p, token) {
        p._insertFakeElement(TAG_NAMES.BODY, TAG_ID.BODY);
        p.insertionMode = InsertionMode.IN_BODY;
        modeInBody(p, token);
    }
    // The "in body" insertion mode
    //------------------------------------------------------------------
    function modeInBody(p, token) {
        switch (token.type) {
            case TokenType.CHARACTER: {
                characterInBody(p, token);
                break;
            }
            case TokenType.WHITESPACE_CHARACTER: {
                whitespaceCharacterInBody(p, token);
                break;
            }
            case TokenType.COMMENT: {
                appendComment(p, token);
                break;
            }
            case TokenType.START_TAG: {
                startTagInBody(p, token);
                break;
            }
            case TokenType.END_TAG: {
                endTagInBody(p, token);
                break;
            }
            case TokenType.EOF: {
                eofInBody(p, token);
                break;
            }
            // Do nothing
        }
    }
    function whitespaceCharacterInBody(p, token) {
        p._reconstructActiveFormattingElements();
        p._insertCharacters(token);
    }
    function characterInBody(p, token) {
        p._reconstructActiveFormattingElements();
        p._insertCharacters(token);
        p.framesetOk = false;
    }
    function htmlStartTagInBody(p, token) {
        if (p.openElements.tmplCount === 0) {
            p.treeAdapter.adoptAttributes(p.openElements.items[0], token.attrs);
        }
    }
    function bodyStartTagInBody(p, token) {
        const bodyElement = p.openElements.tryPeekProperlyNestedBodyElement();
        if (bodyElement && p.openElements.tmplCount === 0) {
            p.framesetOk = false;
            p.treeAdapter.adoptAttributes(bodyElement, token.attrs);
        }
    }
    function framesetStartTagInBody(p, token) {
        const bodyElement = p.openElements.tryPeekProperlyNestedBodyElement();
        if (p.framesetOk && bodyElement) {
            p.treeAdapter.detachNode(bodyElement);
            p.openElements.popAllUpToHtmlElement();
            p._insertElement(token, NS.HTML);
            p.insertionMode = InsertionMode.IN_FRAMESET;
        }
    }
    function addressStartTagInBody(p, token) {
        if (p.openElements.hasInButtonScope(TAG_ID.P)) {
            p._closePElement();
        }
        p._insertElement(token, NS.HTML);
    }
    function numberedHeaderStartTagInBody(p, token) {
        if (p.openElements.hasInButtonScope(TAG_ID.P)) {
            p._closePElement();
        }
        if (isNumberedHeader(p.openElements.currentTagId)) {
            p.openElements.pop();
        }
        p._insertElement(token, NS.HTML);
    }
    function preStartTagInBody(p, token) {
        if (p.openElements.hasInButtonScope(TAG_ID.P)) {
            p._closePElement();
        }
        p._insertElement(token, NS.HTML);
        //NOTE: If the next token is a U+000A LINE FEED (LF) character token, then ignore that token and move
        //on to the next one. (Newlines at the start of pre blocks are ignored as an authoring convenience.)
        p.skipNextNewLine = true;
        p.framesetOk = false;
    }
    function formStartTagInBody(p, token) {
        const inTemplate = p.openElements.tmplCount > 0;
        if (!p.formElement || inTemplate) {
            if (p.openElements.hasInButtonScope(TAG_ID.P)) {
                p._closePElement();
            }
            p._insertElement(token, NS.HTML);
            if (!inTemplate) {
                p.formElement = p.openElements.current;
            }
        }
    }
    function listItemStartTagInBody(p, token) {
        p.framesetOk = false;
        const tn = token.tagID;
        for (let i = p.openElements.stackTop; i >= 0; i--) {
            const elementId = p.openElements.tagIDs[i];
            if ((tn === TAG_ID.LI && elementId === TAG_ID.LI) ||
                ((tn === TAG_ID.DD || tn === TAG_ID.DT) && (elementId === TAG_ID.DD || elementId === TAG_ID.DT))) {
                p.openElements.generateImpliedEndTagsWithExclusion(elementId);
                p.openElements.popUntilTagNamePopped(elementId);
                break;
            }
            if (elementId !== TAG_ID.ADDRESS &&
                elementId !== TAG_ID.DIV &&
                elementId !== TAG_ID.P &&
                p._isSpecialElement(p.openElements.items[i], elementId)) {
                break;
            }
        }
        if (p.openElements.hasInButtonScope(TAG_ID.P)) {
            p._closePElement();
        }
        p._insertElement(token, NS.HTML);
    }
    function plaintextStartTagInBody(p, token) {
        if (p.openElements.hasInButtonScope(TAG_ID.P)) {
            p._closePElement();
        }
        p._insertElement(token, NS.HTML);
        p.tokenizer.state = TokenizerMode.PLAINTEXT;
    }
    function buttonStartTagInBody(p, token) {
        if (p.openElements.hasInScope(TAG_ID.BUTTON)) {
            p.openElements.generateImpliedEndTags();
            p.openElements.popUntilTagNamePopped(TAG_ID.BUTTON);
        }
        p._reconstructActiveFormattingElements();
        p._insertElement(token, NS.HTML);
        p.framesetOk = false;
    }
    function aStartTagInBody(p, token) {
        const activeElementEntry = p.activeFormattingElements.getElementEntryInScopeWithTagName(TAG_NAMES.A);
        if (activeElementEntry) {
            callAdoptionAgency(p, token);
            p.openElements.remove(activeElementEntry.element);
            p.activeFormattingElements.removeEntry(activeElementEntry);
        }
        p._reconstructActiveFormattingElements();
        p._insertElement(token, NS.HTML);
        p.activeFormattingElements.pushElement(p.openElements.current, token);
    }
    function bStartTagInBody(p, token) {
        p._reconstructActiveFormattingElements();
        p._insertElement(token, NS.HTML);
        p.activeFormattingElements.pushElement(p.openElements.current, token);
    }
    function nobrStartTagInBody(p, token) {
        p._reconstructActiveFormattingElements();
        if (p.openElements.hasInScope(TAG_ID.NOBR)) {
            callAdoptionAgency(p, token);
            p._reconstructActiveFormattingElements();
        }
        p._insertElement(token, NS.HTML);
        p.activeFormattingElements.pushElement(p.openElements.current, token);
    }
    function appletStartTagInBody(p, token) {
        p._reconstructActiveFormattingElements();
        p._insertElement(token, NS.HTML);
        p.activeFormattingElements.insertMarker();
        p.framesetOk = false;
    }
    function tableStartTagInBody(p, token) {
        if (p.treeAdapter.getDocumentMode(p.document) !== DOCUMENT_MODE.QUIRKS && p.openElements.hasInButtonScope(TAG_ID.P)) {
            p._closePElement();
        }
        p._insertElement(token, NS.HTML);
        p.framesetOk = false;
        p.insertionMode = InsertionMode.IN_TABLE;
    }
    function areaStartTagInBody(p, token) {
        p._reconstructActiveFormattingElements();
        p._appendElement(token, NS.HTML);
        p.framesetOk = false;
        token.ackSelfClosing = true;
    }
    function isHiddenInput(token) {
        const inputType = getTokenAttr(token, ATTRS.TYPE);
        return inputType != null && inputType.toLowerCase() === HIDDEN_INPUT_TYPE;
    }
    function inputStartTagInBody(p, token) {
        p._reconstructActiveFormattingElements();
        p._appendElement(token, NS.HTML);
        if (!isHiddenInput(token)) {
            p.framesetOk = false;
        }
        token.ackSelfClosing = true;
    }
    function paramStartTagInBody(p, token) {
        p._appendElement(token, NS.HTML);
        token.ackSelfClosing = true;
    }
    function hrStartTagInBody(p, token) {
        if (p.openElements.hasInButtonScope(TAG_ID.P)) {
            p._closePElement();
        }
        p._appendElement(token, NS.HTML);
        p.framesetOk = false;
        token.ackSelfClosing = true;
    }
    function imageStartTagInBody(p, token) {
        token.tagName = TAG_NAMES.IMG;
        token.tagID = TAG_ID.IMG;
        areaStartTagInBody(p, token);
    }
    function textareaStartTagInBody(p, token) {
        p._insertElement(token, NS.HTML);
        //NOTE: If the next token is a U+000A LINE FEED (LF) character token, then ignore that token and move
        //on to the next one. (Newlines at the start of textarea elements are ignored as an authoring convenience.)
        p.skipNextNewLine = true;
        p.tokenizer.state = TokenizerMode.RCDATA;
        p.originalInsertionMode = p.insertionMode;
        p.framesetOk = false;
        p.insertionMode = InsertionMode.TEXT;
    }
    function xmpStartTagInBody(p, token) {
        if (p.openElements.hasInButtonScope(TAG_ID.P)) {
            p._closePElement();
        }
        p._reconstructActiveFormattingElements();
        p.framesetOk = false;
        p._switchToTextParsing(token, TokenizerMode.RAWTEXT);
    }
    function iframeStartTagInBody(p, token) {
        p.framesetOk = false;
        p._switchToTextParsing(token, TokenizerMode.RAWTEXT);
    }
    //NOTE: here we assume that we always act as an user agent with enabled plugins, so we parse
    //<noembed> as rawtext.
    function noembedStartTagInBody(p, token) {
        p._switchToTextParsing(token, TokenizerMode.RAWTEXT);
    }
    function selectStartTagInBody(p, token) {
        p._reconstructActiveFormattingElements();
        p._insertElement(token, NS.HTML);
        p.framesetOk = false;
        p.insertionMode =
            p.insertionMode === InsertionMode.IN_TABLE ||
                p.insertionMode === InsertionMode.IN_CAPTION ||
                p.insertionMode === InsertionMode.IN_TABLE_BODY ||
                p.insertionMode === InsertionMode.IN_ROW ||
                p.insertionMode === InsertionMode.IN_CELL
                ? InsertionMode.IN_SELECT_IN_TABLE
                : InsertionMode.IN_SELECT;
    }
    function optgroupStartTagInBody(p, token) {
        if (p.openElements.currentTagId === TAG_ID.OPTION) {
            p.openElements.pop();
        }
        p._reconstructActiveFormattingElements();
        p._insertElement(token, NS.HTML);
    }
    function rbStartTagInBody(p, token) {
        if (p.openElements.hasInScope(TAG_ID.RUBY)) {
            p.openElements.generateImpliedEndTags();
        }
        p._insertElement(token, NS.HTML);
    }
    function rtStartTagInBody(p, token) {
        if (p.openElements.hasInScope(TAG_ID.RUBY)) {
            p.openElements.generateImpliedEndTagsWithExclusion(TAG_ID.RTC);
        }
        p._insertElement(token, NS.HTML);
    }
    function mathStartTagInBody(p, token) {
        p._reconstructActiveFormattingElements();
        adjustTokenMathMLAttrs(token);
        adjustTokenXMLAttrs(token);
        if (token.selfClosing) {
            p._appendElement(token, NS.MATHML);
        }
        else {
            p._insertElement(token, NS.MATHML);
        }
        token.ackSelfClosing = true;
    }
    function svgStartTagInBody(p, token) {
        p._reconstructActiveFormattingElements();
        adjustTokenSVGAttrs(token);
        adjustTokenXMLAttrs(token);
        if (token.selfClosing) {
            p._appendElement(token, NS.SVG);
        }
        else {
            p._insertElement(token, NS.SVG);
        }
        token.ackSelfClosing = true;
    }
    function genericStartTagInBody(p, token) {
        p._reconstructActiveFormattingElements();
        p._insertElement(token, NS.HTML);
    }
    function startTagInBody(p, token) {
        switch (token.tagID) {
            case TAG_ID.I:
            case TAG_ID.S:
            case TAG_ID.B:
            case TAG_ID.U:
            case TAG_ID.EM:
            case TAG_ID.TT:
            case TAG_ID.BIG:
            case TAG_ID.CODE:
            case TAG_ID.FONT:
            case TAG_ID.SMALL:
            case TAG_ID.STRIKE:
            case TAG_ID.STRONG: {
                bStartTagInBody(p, token);
                break;
            }
            case TAG_ID.A: {
                aStartTagInBody(p, token);
                break;
            }
            case TAG_ID.H1:
            case TAG_ID.H2:
            case TAG_ID.H3:
            case TAG_ID.H4:
            case TAG_ID.H5:
            case TAG_ID.H6: {
                numberedHeaderStartTagInBody(p, token);
                break;
            }
            case TAG_ID.P:
            case TAG_ID.DL:
            case TAG_ID.OL:
            case TAG_ID.UL:
            case TAG_ID.DIV:
            case TAG_ID.DIR:
            case TAG_ID.NAV:
            case TAG_ID.MAIN:
            case TAG_ID.MENU:
            case TAG_ID.ASIDE:
            case TAG_ID.CENTER:
            case TAG_ID.FIGURE:
            case TAG_ID.FOOTER:
            case TAG_ID.HEADER:
            case TAG_ID.HGROUP:
            case TAG_ID.DIALOG:
            case TAG_ID.DETAILS:
            case TAG_ID.ADDRESS:
            case TAG_ID.ARTICLE:
            case TAG_ID.SECTION:
            case TAG_ID.SUMMARY:
            case TAG_ID.FIELDSET:
            case TAG_ID.BLOCKQUOTE:
            case TAG_ID.FIGCAPTION: {
                addressStartTagInBody(p, token);
                break;
            }
            case TAG_ID.LI:
            case TAG_ID.DD:
            case TAG_ID.DT: {
                listItemStartTagInBody(p, token);
                break;
            }
            case TAG_ID.BR:
            case TAG_ID.IMG:
            case TAG_ID.WBR:
            case TAG_ID.AREA:
            case TAG_ID.EMBED:
            case TAG_ID.KEYGEN: {
                areaStartTagInBody(p, token);
                break;
            }
            case TAG_ID.HR: {
                hrStartTagInBody(p, token);
                break;
            }
            case TAG_ID.RB:
            case TAG_ID.RTC: {
                rbStartTagInBody(p, token);
                break;
            }
            case TAG_ID.RT:
            case TAG_ID.RP: {
                rtStartTagInBody(p, token);
                break;
            }
            case TAG_ID.PRE:
            case TAG_ID.LISTING: {
                preStartTagInBody(p, token);
                break;
            }
            case TAG_ID.XMP: {
                xmpStartTagInBody(p, token);
                break;
            }
            case TAG_ID.SVG: {
                svgStartTagInBody(p, token);
                break;
            }
            case TAG_ID.HTML: {
                htmlStartTagInBody(p, token);
                break;
            }
            case TAG_ID.BASE:
            case TAG_ID.LINK:
            case TAG_ID.META:
            case TAG_ID.STYLE:
            case TAG_ID.TITLE:
            case TAG_ID.SCRIPT:
            case TAG_ID.BGSOUND:
            case TAG_ID.BASEFONT:
            case TAG_ID.TEMPLATE: {
                startTagInHead(p, token);
                break;
            }
            case TAG_ID.BODY: {
                bodyStartTagInBody(p, token);
                break;
            }
            case TAG_ID.FORM: {
                formStartTagInBody(p, token);
                break;
            }
            case TAG_ID.NOBR: {
                nobrStartTagInBody(p, token);
                break;
            }
            case TAG_ID.MATH: {
                mathStartTagInBody(p, token);
                break;
            }
            case TAG_ID.TABLE: {
                tableStartTagInBody(p, token);
                break;
            }
            case TAG_ID.INPUT: {
                inputStartTagInBody(p, token);
                break;
            }
            case TAG_ID.PARAM:
            case TAG_ID.TRACK:
            case TAG_ID.SOURCE: {
                paramStartTagInBody(p, token);
                break;
            }
            case TAG_ID.IMAGE: {
                imageStartTagInBody(p, token);
                break;
            }
            case TAG_ID.BUTTON: {
                buttonStartTagInBody(p, token);
                break;
            }
            case TAG_ID.APPLET:
            case TAG_ID.OBJECT:
            case TAG_ID.MARQUEE: {
                appletStartTagInBody(p, token);
                break;
            }
            case TAG_ID.IFRAME: {
                iframeStartTagInBody(p, token);
                break;
            }
            case TAG_ID.SELECT: {
                selectStartTagInBody(p, token);
                break;
            }
            case TAG_ID.OPTION:
            case TAG_ID.OPTGROUP: {
                optgroupStartTagInBody(p, token);
                break;
            }
            case TAG_ID.NOEMBED: {
                noembedStartTagInBody(p, token);
                break;
            }
            case TAG_ID.FRAMESET: {
                framesetStartTagInBody(p, token);
                break;
            }
            case TAG_ID.TEXTAREA: {
                textareaStartTagInBody(p, token);
                break;
            }
            case TAG_ID.NOSCRIPT: {
                if (p.options.scriptingEnabled) {
                    noembedStartTagInBody(p, token);
                }
                else {
                    genericStartTagInBody(p, token);
                }
                break;
            }
            case TAG_ID.PLAINTEXT: {
                plaintextStartTagInBody(p, token);
                break;
            }
            case TAG_ID.COL:
            case TAG_ID.TH:
            case TAG_ID.TD:
            case TAG_ID.TR:
            case TAG_ID.HEAD:
            case TAG_ID.FRAME:
            case TAG_ID.TBODY:
            case TAG_ID.TFOOT:
            case TAG_ID.THEAD:
            case TAG_ID.CAPTION:
            case TAG_ID.COLGROUP: {
                // Ignore token
                break;
            }
            default: {
                genericStartTagInBody(p, token);
            }
        }
    }
    function bodyEndTagInBody(p, token) {
        if (p.openElements.hasInScope(TAG_ID.BODY)) {
            p.insertionMode = InsertionMode.AFTER_BODY;
            //NOTE: <body> is never popped from the stack, so we need to updated
            //the end location explicitly.
            if (p.options.sourceCodeLocationInfo) {
                const bodyElement = p.openElements.tryPeekProperlyNestedBodyElement();
                if (bodyElement) {
                    p._setEndLocation(bodyElement, token);
                }
            }
        }
    }
    function htmlEndTagInBody(p, token) {
        if (p.openElements.hasInScope(TAG_ID.BODY)) {
            p.insertionMode = InsertionMode.AFTER_BODY;
            endTagAfterBody(p, token);
        }
    }
    function addressEndTagInBody(p, token) {
        const tn = token.tagID;
        if (p.openElements.hasInScope(tn)) {
            p.openElements.generateImpliedEndTags();
            p.openElements.popUntilTagNamePopped(tn);
        }
    }
    function formEndTagInBody(p) {
        const inTemplate = p.openElements.tmplCount > 0;
        const { formElement } = p;
        if (!inTemplate) {
            p.formElement = null;
        }
        if ((formElement || inTemplate) && p.openElements.hasInScope(TAG_ID.FORM)) {
            p.openElements.generateImpliedEndTags();
            if (inTemplate) {
                p.openElements.popUntilTagNamePopped(TAG_ID.FORM);
            }
            else if (formElement) {
                p.openElements.remove(formElement);
            }
        }
    }
    function pEndTagInBody(p) {
        if (!p.openElements.hasInButtonScope(TAG_ID.P)) {
            p._insertFakeElement(TAG_NAMES.P, TAG_ID.P);
        }
        p._closePElement();
    }
    function liEndTagInBody(p) {
        if (p.openElements.hasInListItemScope(TAG_ID.LI)) {
            p.openElements.generateImpliedEndTagsWithExclusion(TAG_ID.LI);
            p.openElements.popUntilTagNamePopped(TAG_ID.LI);
        }
    }
    function ddEndTagInBody(p, token) {
        const tn = token.tagID;
        if (p.openElements.hasInScope(tn)) {
            p.openElements.generateImpliedEndTagsWithExclusion(tn);
            p.openElements.popUntilTagNamePopped(tn);
        }
    }
    function numberedHeaderEndTagInBody(p) {
        if (p.openElements.hasNumberedHeaderInScope()) {
            p.openElements.generateImpliedEndTags();
            p.openElements.popUntilNumberedHeaderPopped();
        }
    }
    function appletEndTagInBody(p, token) {
        const tn = token.tagID;
        if (p.openElements.hasInScope(tn)) {
            p.openElements.generateImpliedEndTags();
            p.openElements.popUntilTagNamePopped(tn);
            p.activeFormattingElements.clearToLastMarker();
        }
    }
    function brEndTagInBody(p) {
        p._reconstructActiveFormattingElements();
        p._insertFakeElement(TAG_NAMES.BR, TAG_ID.BR);
        p.openElements.pop();
        p.framesetOk = false;
    }
    function genericEndTagInBody(p, token) {
        const tn = token.tagName;
        const tid = token.tagID;
        for (let i = p.openElements.stackTop; i > 0; i--) {
            const element = p.openElements.items[i];
            const elementId = p.openElements.tagIDs[i];
            // Compare the tag name here, as the tag might not be a known tag with an ID.
            if (tid === elementId && (tid !== TAG_ID.UNKNOWN || p.treeAdapter.getTagName(element) === tn)) {
                p.openElements.generateImpliedEndTagsWithExclusion(tid);
                if (p.openElements.stackTop >= i)
                    p.openElements.shortenToLength(i);
                break;
            }
            if (p._isSpecialElement(element, elementId)) {
                break;
            }
        }
    }
    function endTagInBody(p, token) {
        switch (token.tagID) {
            case TAG_ID.A:
            case TAG_ID.B:
            case TAG_ID.I:
            case TAG_ID.S:
            case TAG_ID.U:
            case TAG_ID.EM:
            case TAG_ID.TT:
            case TAG_ID.BIG:
            case TAG_ID.CODE:
            case TAG_ID.FONT:
            case TAG_ID.NOBR:
            case TAG_ID.SMALL:
            case TAG_ID.STRIKE:
            case TAG_ID.STRONG: {
                callAdoptionAgency(p, token);
                break;
            }
            case TAG_ID.P: {
                pEndTagInBody(p);
                break;
            }
            case TAG_ID.DL:
            case TAG_ID.UL:
            case TAG_ID.OL:
            case TAG_ID.DIR:
            case TAG_ID.DIV:
            case TAG_ID.NAV:
            case TAG_ID.PRE:
            case TAG_ID.MAIN:
            case TAG_ID.MENU:
            case TAG_ID.ASIDE:
            case TAG_ID.CENTER:
            case TAG_ID.FIGURE:
            case TAG_ID.FOOTER:
            case TAG_ID.HEADER:
            case TAG_ID.HGROUP:
            case TAG_ID.DIALOG:
            case TAG_ID.ADDRESS:
            case TAG_ID.ARTICLE:
            case TAG_ID.DETAILS:
            case TAG_ID.SECTION:
            case TAG_ID.SUMMARY:
            case TAG_ID.LISTING:
            case TAG_ID.FIELDSET:
            case TAG_ID.BLOCKQUOTE:
            case TAG_ID.FIGCAPTION: {
                addressEndTagInBody(p, token);
                break;
            }
            case TAG_ID.LI: {
                liEndTagInBody(p);
                break;
            }
            case TAG_ID.DD:
            case TAG_ID.DT: {
                ddEndTagInBody(p, token);
                break;
            }
            case TAG_ID.H1:
            case TAG_ID.H2:
            case TAG_ID.H3:
            case TAG_ID.H4:
            case TAG_ID.H5:
            case TAG_ID.H6: {
                numberedHeaderEndTagInBody(p);
                break;
            }
            case TAG_ID.BR: {
                brEndTagInBody(p);
                break;
            }
            case TAG_ID.BODY: {
                bodyEndTagInBody(p, token);
                break;
            }
            case TAG_ID.HTML: {
                htmlEndTagInBody(p, token);
                break;
            }
            case TAG_ID.FORM: {
                formEndTagInBody(p);
                break;
            }
            case TAG_ID.APPLET:
            case TAG_ID.OBJECT:
            case TAG_ID.MARQUEE: {
                appletEndTagInBody(p, token);
                break;
            }
            case TAG_ID.TEMPLATE: {
                endTagInHead(p, token);
                break;
            }
            default: {
                genericEndTagInBody(p, token);
            }
        }
    }
    function eofInBody(p, token) {
        if (p.tmplInsertionModeStack.length > 0) {
            eofInTemplate(p, token);
        }
        else {
            stopParsing(p, token);
        }
    }
    // The "text" insertion mode
    //------------------------------------------------------------------
    function endTagInText(p, token) {
        var _a;
        if (token.tagID === TAG_ID.SCRIPT) {
            (_a = p.scriptHandler) === null || _a === void 0 ? void 0 : _a.call(p, p.openElements.current);
        }
        p.openElements.pop();
        p.insertionMode = p.originalInsertionMode;
    }
    function eofInText(p, token) {
        p._err(token, ERR.eofInElementThatCanContainOnlyText);
        p.openElements.pop();
        p.insertionMode = p.originalInsertionMode;
        p.onEof(token);
    }
    // The "in table" insertion mode
    //------------------------------------------------------------------
    function characterInTable(p, token) {
        if (TABLE_STRUCTURE_TAGS.has(p.openElements.currentTagId)) {
            p.pendingCharacterTokens.length = 0;
            p.hasNonWhitespacePendingCharacterToken = false;
            p.originalInsertionMode = p.insertionMode;
            p.insertionMode = InsertionMode.IN_TABLE_TEXT;
            switch (token.type) {
                case TokenType.CHARACTER: {
                    characterInTableText(p, token);
                    break;
                }
                case TokenType.WHITESPACE_CHARACTER: {
                    whitespaceCharacterInTableText(p, token);
                    break;
                }
                // Ignore null
            }
        }
        else {
            tokenInTable(p, token);
        }
    }
    function captionStartTagInTable(p, token) {
        p.openElements.clearBackToTableContext();
        p.activeFormattingElements.insertMarker();
        p._insertElement(token, NS.HTML);
        p.insertionMode = InsertionMode.IN_CAPTION;
    }
    function colgroupStartTagInTable(p, token) {
        p.openElements.clearBackToTableContext();
        p._insertElement(token, NS.HTML);
        p.insertionMode = InsertionMode.IN_COLUMN_GROUP;
    }
    function colStartTagInTable(p, token) {
        p.openElements.clearBackToTableContext();
        p._insertFakeElement(TAG_NAMES.COLGROUP, TAG_ID.COLGROUP);
        p.insertionMode = InsertionMode.IN_COLUMN_GROUP;
        startTagInColumnGroup(p, token);
    }
    function tbodyStartTagInTable(p, token) {
        p.openElements.clearBackToTableContext();
        p._insertElement(token, NS.HTML);
        p.insertionMode = InsertionMode.IN_TABLE_BODY;
    }
    function tdStartTagInTable(p, token) {
        p.openElements.clearBackToTableContext();
        p._insertFakeElement(TAG_NAMES.TBODY, TAG_ID.TBODY);
        p.insertionMode = InsertionMode.IN_TABLE_BODY;
        startTagInTableBody(p, token);
    }
    function tableStartTagInTable(p, token) {
        if (p.openElements.hasInTableScope(TAG_ID.TABLE)) {
            p.openElements.popUntilTagNamePopped(TAG_ID.TABLE);
            p._resetInsertionMode();
            p._processStartTag(token);
        }
    }
    function inputStartTagInTable(p, token) {
        if (isHiddenInput(token)) {
            p._appendElement(token, NS.HTML);
        }
        else {
            tokenInTable(p, token);
        }
        token.ackSelfClosing = true;
    }
    function formStartTagInTable(p, token) {
        if (!p.formElement && p.openElements.tmplCount === 0) {
            p._insertElement(token, NS.HTML);
            p.formElement = p.openElements.current;
            p.openElements.pop();
        }
    }
    function startTagInTable(p, token) {
        switch (token.tagID) {
            case TAG_ID.TD:
            case TAG_ID.TH:
            case TAG_ID.TR: {
                tdStartTagInTable(p, token);
                break;
            }
            case TAG_ID.STYLE:
            case TAG_ID.SCRIPT:
            case TAG_ID.TEMPLATE: {
                startTagInHead(p, token);
                break;
            }
            case TAG_ID.COL: {
                colStartTagInTable(p, token);
                break;
            }
            case TAG_ID.FORM: {
                formStartTagInTable(p, token);
                break;
            }
            case TAG_ID.TABLE: {
                tableStartTagInTable(p, token);
                break;
            }
            case TAG_ID.TBODY:
            case TAG_ID.TFOOT:
            case TAG_ID.THEAD: {
                tbodyStartTagInTable(p, token);
                break;
            }
            case TAG_ID.INPUT: {
                inputStartTagInTable(p, token);
                break;
            }
            case TAG_ID.CAPTION: {
                captionStartTagInTable(p, token);
                break;
            }
            case TAG_ID.COLGROUP: {
                colgroupStartTagInTable(p, token);
                break;
            }
            default: {
                tokenInTable(p, token);
            }
        }
    }
    function endTagInTable(p, token) {
        switch (token.tagID) {
            case TAG_ID.TABLE: {
                if (p.openElements.hasInTableScope(TAG_ID.TABLE)) {
                    p.openElements.popUntilTagNamePopped(TAG_ID.TABLE);
                    p._resetInsertionMode();
                }
                break;
            }
            case TAG_ID.TEMPLATE: {
                endTagInHead(p, token);
                break;
            }
            case TAG_ID.BODY:
            case TAG_ID.CAPTION:
            case TAG_ID.COL:
            case TAG_ID.COLGROUP:
            case TAG_ID.HTML:
            case TAG_ID.TBODY:
            case TAG_ID.TD:
            case TAG_ID.TFOOT:
            case TAG_ID.TH:
            case TAG_ID.THEAD:
            case TAG_ID.TR: {
                // Ignore token
                break;
            }
            default: {
                tokenInTable(p, token);
            }
        }
    }
    function tokenInTable(p, token) {
        const savedFosterParentingState = p.fosterParentingEnabled;
        p.fosterParentingEnabled = true;
        // Process token in `In Body` mode
        modeInBody(p, token);
        p.fosterParentingEnabled = savedFosterParentingState;
    }
    // The "in table text" insertion mode
    //------------------------------------------------------------------
    function whitespaceCharacterInTableText(p, token) {
        p.pendingCharacterTokens.push(token);
    }
    function characterInTableText(p, token) {
        p.pendingCharacterTokens.push(token);
        p.hasNonWhitespacePendingCharacterToken = true;
    }
    function tokenInTableText(p, token) {
        let i = 0;
        if (p.hasNonWhitespacePendingCharacterToken) {
            for (; i < p.pendingCharacterTokens.length; i++) {
                tokenInTable(p, p.pendingCharacterTokens[i]);
            }
        }
        else {
            for (; i < p.pendingCharacterTokens.length; i++) {
                p._insertCharacters(p.pendingCharacterTokens[i]);
            }
        }
        p.insertionMode = p.originalInsertionMode;
        p._processToken(token);
    }
    // The "in caption" insertion mode
    //------------------------------------------------------------------
    const TABLE_VOID_ELEMENTS = new Set([TAG_ID.CAPTION, TAG_ID.COL, TAG_ID.COLGROUP, TAG_ID.TBODY, TAG_ID.TD, TAG_ID.TFOOT, TAG_ID.TH, TAG_ID.THEAD, TAG_ID.TR]);
    function startTagInCaption(p, token) {
        const tn = token.tagID;
        if (TABLE_VOID_ELEMENTS.has(tn)) {
            if (p.openElements.hasInTableScope(TAG_ID.CAPTION)) {
                p.openElements.generateImpliedEndTags();
                p.openElements.popUntilTagNamePopped(TAG_ID.CAPTION);
                p.activeFormattingElements.clearToLastMarker();
                p.insertionMode = InsertionMode.IN_TABLE;
                startTagInTable(p, token);
            }
        }
        else {
            startTagInBody(p, token);
        }
    }
    function endTagInCaption(p, token) {
        const tn = token.tagID;
        switch (tn) {
            case TAG_ID.CAPTION:
            case TAG_ID.TABLE: {
                if (p.openElements.hasInTableScope(TAG_ID.CAPTION)) {
                    p.openElements.generateImpliedEndTags();
                    p.openElements.popUntilTagNamePopped(TAG_ID.CAPTION);
                    p.activeFormattingElements.clearToLastMarker();
                    p.insertionMode = InsertionMode.IN_TABLE;
                    if (tn === TAG_ID.TABLE) {
                        endTagInTable(p, token);
                    }
                }
                break;
            }
            case TAG_ID.BODY:
            case TAG_ID.COL:
            case TAG_ID.COLGROUP:
            case TAG_ID.HTML:
            case TAG_ID.TBODY:
            case TAG_ID.TD:
            case TAG_ID.TFOOT:
            case TAG_ID.TH:
            case TAG_ID.THEAD:
            case TAG_ID.TR: {
                // Ignore token
                break;
            }
            default: {
                endTagInBody(p, token);
            }
        }
    }
    // The "in column group" insertion mode
    //------------------------------------------------------------------
    function startTagInColumnGroup(p, token) {
        switch (token.tagID) {
            case TAG_ID.HTML: {
                startTagInBody(p, token);
                break;
            }
            case TAG_ID.COL: {
                p._appendElement(token, NS.HTML);
                token.ackSelfClosing = true;
                break;
            }
            case TAG_ID.TEMPLATE: {
                startTagInHead(p, token);
                break;
            }
            default: {
                tokenInColumnGroup(p, token);
            }
        }
    }
    function endTagInColumnGroup(p, token) {
        switch (token.tagID) {
            case TAG_ID.COLGROUP: {
                if (p.openElements.currentTagId === TAG_ID.COLGROUP) {
                    p.openElements.pop();
                    p.insertionMode = InsertionMode.IN_TABLE;
                }
                break;
            }
            case TAG_ID.TEMPLATE: {
                endTagInHead(p, token);
                break;
            }
            case TAG_ID.COL: {
                // Ignore token
                break;
            }
            default: {
                tokenInColumnGroup(p, token);
            }
        }
    }
    function tokenInColumnGroup(p, token) {
        if (p.openElements.currentTagId === TAG_ID.COLGROUP) {
            p.openElements.pop();
            p.insertionMode = InsertionMode.IN_TABLE;
            p._processToken(token);
        }
    }
    // The "in table body" insertion mode
    //------------------------------------------------------------------
    function startTagInTableBody(p, token) {
        switch (token.tagID) {
            case TAG_ID.TR: {
                p.openElements.clearBackToTableBodyContext();
                p._insertElement(token, NS.HTML);
                p.insertionMode = InsertionMode.IN_ROW;
                break;
            }
            case TAG_ID.TH:
            case TAG_ID.TD: {
                p.openElements.clearBackToTableBodyContext();
                p._insertFakeElement(TAG_NAMES.TR, TAG_ID.TR);
                p.insertionMode = InsertionMode.IN_ROW;
                startTagInRow(p, token);
                break;
            }
            case TAG_ID.CAPTION:
            case TAG_ID.COL:
            case TAG_ID.COLGROUP:
            case TAG_ID.TBODY:
            case TAG_ID.TFOOT:
            case TAG_ID.THEAD: {
                if (p.openElements.hasTableBodyContextInTableScope()) {
                    p.openElements.clearBackToTableBodyContext();
                    p.openElements.pop();
                    p.insertionMode = InsertionMode.IN_TABLE;
                    startTagInTable(p, token);
                }
                break;
            }
            default: {
                startTagInTable(p, token);
            }
        }
    }
    function endTagInTableBody(p, token) {
        const tn = token.tagID;
        switch (token.tagID) {
            case TAG_ID.TBODY:
            case TAG_ID.TFOOT:
            case TAG_ID.THEAD: {
                if (p.openElements.hasInTableScope(tn)) {
                    p.openElements.clearBackToTableBodyContext();
                    p.openElements.pop();
                    p.insertionMode = InsertionMode.IN_TABLE;
                }
                break;
            }
            case TAG_ID.TABLE: {
                if (p.openElements.hasTableBodyContextInTableScope()) {
                    p.openElements.clearBackToTableBodyContext();
                    p.openElements.pop();
                    p.insertionMode = InsertionMode.IN_TABLE;
                    endTagInTable(p, token);
                }
                break;
            }
            case TAG_ID.BODY:
            case TAG_ID.CAPTION:
            case TAG_ID.COL:
            case TAG_ID.COLGROUP:
            case TAG_ID.HTML:
            case TAG_ID.TD:
            case TAG_ID.TH:
            case TAG_ID.TR: {
                // Ignore token
                break;
            }
            default: {
                endTagInTable(p, token);
            }
        }
    }
    // The "in row" insertion mode
    //------------------------------------------------------------------
    function startTagInRow(p, token) {
        switch (token.tagID) {
            case TAG_ID.TH:
            case TAG_ID.TD: {
                p.openElements.clearBackToTableRowContext();
                p._insertElement(token, NS.HTML);
                p.insertionMode = InsertionMode.IN_CELL;
                p.activeFormattingElements.insertMarker();
                break;
            }
            case TAG_ID.CAPTION:
            case TAG_ID.COL:
            case TAG_ID.COLGROUP:
            case TAG_ID.TBODY:
            case TAG_ID.TFOOT:
            case TAG_ID.THEAD:
            case TAG_ID.TR: {
                if (p.openElements.hasInTableScope(TAG_ID.TR)) {
                    p.openElements.clearBackToTableRowContext();
                    p.openElements.pop();
                    p.insertionMode = InsertionMode.IN_TABLE_BODY;
                    startTagInTableBody(p, token);
                }
                break;
            }
            default: {
                startTagInTable(p, token);
            }
        }
    }
    function endTagInRow(p, token) {
        switch (token.tagID) {
            case TAG_ID.TR: {
                if (p.openElements.hasInTableScope(TAG_ID.TR)) {
                    p.openElements.clearBackToTableRowContext();
                    p.openElements.pop();
                    p.insertionMode = InsertionMode.IN_TABLE_BODY;
                }
                break;
            }
            case TAG_ID.TABLE: {
                if (p.openElements.hasInTableScope(TAG_ID.TR)) {
                    p.openElements.clearBackToTableRowContext();
                    p.openElements.pop();
                    p.insertionMode = InsertionMode.IN_TABLE_BODY;
                    endTagInTableBody(p, token);
                }
                break;
            }
            case TAG_ID.TBODY:
            case TAG_ID.TFOOT:
            case TAG_ID.THEAD: {
                if (p.openElements.hasInTableScope(token.tagID) || p.openElements.hasInTableScope(TAG_ID.TR)) {
                    p.openElements.clearBackToTableRowContext();
                    p.openElements.pop();
                    p.insertionMode = InsertionMode.IN_TABLE_BODY;
                    endTagInTableBody(p, token);
                }
                break;
            }
            case TAG_ID.BODY:
            case TAG_ID.CAPTION:
            case TAG_ID.COL:
            case TAG_ID.COLGROUP:
            case TAG_ID.HTML:
            case TAG_ID.TD:
            case TAG_ID.TH: {
                // Ignore end tag
                break;
            }
            default:
                endTagInTable(p, token);
        }
    }
    // The "in cell" insertion mode
    //------------------------------------------------------------------
    function startTagInCell(p, token) {
        const tn = token.tagID;
        if (TABLE_VOID_ELEMENTS.has(tn)) {
            if (p.openElements.hasInTableScope(TAG_ID.TD) || p.openElements.hasInTableScope(TAG_ID.TH)) {
                p._closeTableCell();
                startTagInRow(p, token);
            }
        }
        else {
            startTagInBody(p, token);
        }
    }
    function endTagInCell(p, token) {
        const tn = token.tagID;
        switch (tn) {
            case TAG_ID.TD:
            case TAG_ID.TH: {
                if (p.openElements.hasInTableScope(tn)) {
                    p.openElements.generateImpliedEndTags();
                    p.openElements.popUntilTagNamePopped(tn);
                    p.activeFormattingElements.clearToLastMarker();
                    p.insertionMode = InsertionMode.IN_ROW;
                }
                break;
            }
            case TAG_ID.TABLE:
            case TAG_ID.TBODY:
            case TAG_ID.TFOOT:
            case TAG_ID.THEAD:
            case TAG_ID.TR: {
                if (p.openElements.hasInTableScope(tn)) {
                    p._closeTableCell();
                    endTagInRow(p, token);
                }
                break;
            }
            case TAG_ID.BODY:
            case TAG_ID.CAPTION:
            case TAG_ID.COL:
            case TAG_ID.COLGROUP:
            case TAG_ID.HTML: {
                // Ignore token
                break;
            }
            default: {
                endTagInBody(p, token);
            }
        }
    }
    // The "in select" insertion mode
    //------------------------------------------------------------------
    function startTagInSelect(p, token) {
        switch (token.tagID) {
            case TAG_ID.HTML: {
                startTagInBody(p, token);
                break;
            }
            case TAG_ID.OPTION: {
                if (p.openElements.currentTagId === TAG_ID.OPTION) {
                    p.openElements.pop();
                }
                p._insertElement(token, NS.HTML);
                break;
            }
            case TAG_ID.OPTGROUP: {
                if (p.openElements.currentTagId === TAG_ID.OPTION) {
                    p.openElements.pop();
                }
                if (p.openElements.currentTagId === TAG_ID.OPTGROUP) {
                    p.openElements.pop();
                }
                p._insertElement(token, NS.HTML);
                break;
            }
            case TAG_ID.INPUT:
            case TAG_ID.KEYGEN:
            case TAG_ID.TEXTAREA:
            case TAG_ID.SELECT: {
                if (p.openElements.hasInSelectScope(TAG_ID.SELECT)) {
                    p.openElements.popUntilTagNamePopped(TAG_ID.SELECT);
                    p._resetInsertionMode();
                    if (token.tagID !== TAG_ID.SELECT) {
                        p._processStartTag(token);
                    }
                }
                break;
            }
            case TAG_ID.SCRIPT:
            case TAG_ID.TEMPLATE: {
                startTagInHead(p, token);
                break;
            }
            // Do nothing
        }
    }
    function endTagInSelect(p, token) {
        switch (token.tagID) {
            case TAG_ID.OPTGROUP: {
                if (p.openElements.stackTop > 0 &&
                    p.openElements.currentTagId === TAG_ID.OPTION &&
                    p.openElements.tagIDs[p.openElements.stackTop - 1] === TAG_ID.OPTGROUP) {
                    p.openElements.pop();
                }
                if (p.openElements.currentTagId === TAG_ID.OPTGROUP) {
                    p.openElements.pop();
                }
                break;
            }
            case TAG_ID.OPTION: {
                if (p.openElements.currentTagId === TAG_ID.OPTION) {
                    p.openElements.pop();
                }
                break;
            }
            case TAG_ID.SELECT: {
                if (p.openElements.hasInSelectScope(TAG_ID.SELECT)) {
                    p.openElements.popUntilTagNamePopped(TAG_ID.SELECT);
                    p._resetInsertionMode();
                }
                break;
            }
            case TAG_ID.TEMPLATE: {
                endTagInHead(p, token);
                break;
            }
            // Do nothing
        }
    }
    // The "in select in table" insertion mode
    //------------------------------------------------------------------
    function startTagInSelectInTable(p, token) {
        const tn = token.tagID;
        if (tn === TAG_ID.CAPTION ||
            tn === TAG_ID.TABLE ||
            tn === TAG_ID.TBODY ||
            tn === TAG_ID.TFOOT ||
            tn === TAG_ID.THEAD ||
            tn === TAG_ID.TR ||
            tn === TAG_ID.TD ||
            tn === TAG_ID.TH) {
            p.openElements.popUntilTagNamePopped(TAG_ID.SELECT);
            p._resetInsertionMode();
            p._processStartTag(token);
        }
        else {
            startTagInSelect(p, token);
        }
    }
    function endTagInSelectInTable(p, token) {
        const tn = token.tagID;
        if (tn === TAG_ID.CAPTION ||
            tn === TAG_ID.TABLE ||
            tn === TAG_ID.TBODY ||
            tn === TAG_ID.TFOOT ||
            tn === TAG_ID.THEAD ||
            tn === TAG_ID.TR ||
            tn === TAG_ID.TD ||
            tn === TAG_ID.TH) {
            if (p.openElements.hasInTableScope(tn)) {
                p.openElements.popUntilTagNamePopped(TAG_ID.SELECT);
                p._resetInsertionMode();
                p.onEndTag(token);
            }
        }
        else {
            endTagInSelect(p, token);
        }
    }
    // The "in template" insertion mode
    //------------------------------------------------------------------
    function startTagInTemplate(p, token) {
        switch (token.tagID) {
            // First, handle tags that can start without a mode change
            case TAG_ID.BASE:
            case TAG_ID.BASEFONT:
            case TAG_ID.BGSOUND:
            case TAG_ID.LINK:
            case TAG_ID.META:
            case TAG_ID.NOFRAMES:
            case TAG_ID.SCRIPT:
            case TAG_ID.STYLE:
            case TAG_ID.TEMPLATE:
            case TAG_ID.TITLE:
                startTagInHead(p, token);
                break;
            // Re-process the token in the appropriate mode
            case TAG_ID.CAPTION:
            case TAG_ID.COLGROUP:
            case TAG_ID.TBODY:
            case TAG_ID.TFOOT:
            case TAG_ID.THEAD:
                p.tmplInsertionModeStack[0] = InsertionMode.IN_TABLE;
                p.insertionMode = InsertionMode.IN_TABLE;
                startTagInTable(p, token);
                break;
            case TAG_ID.COL:
                p.tmplInsertionModeStack[0] = InsertionMode.IN_COLUMN_GROUP;
                p.insertionMode = InsertionMode.IN_COLUMN_GROUP;
                startTagInColumnGroup(p, token);
                break;
            case TAG_ID.TR:
                p.tmplInsertionModeStack[0] = InsertionMode.IN_TABLE_BODY;
                p.insertionMode = InsertionMode.IN_TABLE_BODY;
                startTagInTableBody(p, token);
                break;
            case TAG_ID.TD:
            case TAG_ID.TH:
                p.tmplInsertionModeStack[0] = InsertionMode.IN_ROW;
                p.insertionMode = InsertionMode.IN_ROW;
                startTagInRow(p, token);
                break;
            default:
                p.tmplInsertionModeStack[0] = InsertionMode.IN_BODY;
                p.insertionMode = InsertionMode.IN_BODY;
                startTagInBody(p, token);
        }
    }
    function endTagInTemplate(p, token) {
        if (token.tagID === TAG_ID.TEMPLATE) {
            endTagInHead(p, token);
        }
    }
    function eofInTemplate(p, token) {
        if (p.openElements.tmplCount > 0) {
            p.openElements.popUntilTagNamePopped(TAG_ID.TEMPLATE);
            p.activeFormattingElements.clearToLastMarker();
            p.tmplInsertionModeStack.shift();
            p._resetInsertionMode();
            p.onEof(token);
        }
        else {
            stopParsing(p, token);
        }
    }
    // The "after body" insertion mode
    //------------------------------------------------------------------
    function startTagAfterBody(p, token) {
        if (token.tagID === TAG_ID.HTML) {
            startTagInBody(p, token);
        }
        else {
            tokenAfterBody(p, token);
        }
    }
    function endTagAfterBody(p, token) {
        var _a;
        if (token.tagID === TAG_ID.HTML) {
            if (!p.fragmentContext) {
                p.insertionMode = InsertionMode.AFTER_AFTER_BODY;
            }
            //NOTE: <html> is never popped from the stack, so we need to updated
            //the end location explicitly.
            if (p.options.sourceCodeLocationInfo && p.openElements.tagIDs[0] === TAG_ID.HTML) {
                p._setEndLocation(p.openElements.items[0], token);
                // Update the body element, if it doesn't have an end tag
                const bodyElement = p.openElements.items[1];
                if (bodyElement && !((_a = p.treeAdapter.getNodeSourceCodeLocation(bodyElement)) === null || _a === void 0 ? void 0 : _a.endTag)) {
                    p._setEndLocation(bodyElement, token);
                }
            }
        }
        else {
            tokenAfterBody(p, token);
        }
    }
    function tokenAfterBody(p, token) {
        p.insertionMode = InsertionMode.IN_BODY;
        modeInBody(p, token);
    }
    // The "in frameset" insertion mode
    //------------------------------------------------------------------
    function startTagInFrameset(p, token) {
        switch (token.tagID) {
            case TAG_ID.HTML: {
                startTagInBody(p, token);
                break;
            }
            case TAG_ID.FRAMESET: {
                p._insertElement(token, NS.HTML);
                break;
            }
            case TAG_ID.FRAME: {
                p._appendElement(token, NS.HTML);
                token.ackSelfClosing = true;
                break;
            }
            case TAG_ID.NOFRAMES: {
                startTagInHead(p, token);
                break;
            }
            // Do nothing
        }
    }
    function endTagInFrameset(p, token) {
        if (token.tagID === TAG_ID.FRAMESET && !p.openElements.isRootHtmlElementCurrent()) {
            p.openElements.pop();
            if (!p.fragmentContext && p.openElements.currentTagId !== TAG_ID.FRAMESET) {
                p.insertionMode = InsertionMode.AFTER_FRAMESET;
            }
        }
    }
    // The "after frameset" insertion mode
    //------------------------------------------------------------------
    function startTagAfterFrameset(p, token) {
        switch (token.tagID) {
            case TAG_ID.HTML: {
                startTagInBody(p, token);
                break;
            }
            case TAG_ID.NOFRAMES: {
                startTagInHead(p, token);
                break;
            }
            // Do nothing
        }
    }
    function endTagAfterFrameset(p, token) {
        if (token.tagID === TAG_ID.HTML) {
            p.insertionMode = InsertionMode.AFTER_AFTER_FRAMESET;
        }
    }
    // The "after after body" insertion mode
    //------------------------------------------------------------------
    function startTagAfterAfterBody(p, token) {
        if (token.tagID === TAG_ID.HTML) {
            startTagInBody(p, token);
        }
        else {
            tokenAfterAfterBody(p, token);
        }
    }
    function tokenAfterAfterBody(p, token) {
        p.insertionMode = InsertionMode.IN_BODY;
        modeInBody(p, token);
    }
    // The "after after frameset" insertion mode
    //------------------------------------------------------------------
    function startTagAfterAfterFrameset(p, token) {
        switch (token.tagID) {
            case TAG_ID.HTML: {
                startTagInBody(p, token);
                break;
            }
            case TAG_ID.NOFRAMES: {
                startTagInHead(p, token);
                break;
            }
            // Do nothing
        }
    }
    // The rules for parsing tokens in foreign content
    //------------------------------------------------------------------
    function nullCharacterInForeignContent(p, token) {
        token.chars = REPLACEMENT_CHARACTER;
        p._insertCharacters(token);
    }
    function characterInForeignContent(p, token) {
        p._insertCharacters(token);
        p.framesetOk = false;
    }
    function popUntilHtmlOrIntegrationPoint(p) {
        while (p.treeAdapter.getNamespaceURI(p.openElements.current) !== NS.HTML &&
            !p._isIntegrationPoint(p.openElements.currentTagId, p.openElements.current)) {
            p.openElements.pop();
        }
    }
    function startTagInForeignContent(p, token) {
        if (causesExit(token)) {
            popUntilHtmlOrIntegrationPoint(p);
            p._startTagOutsideForeignContent(token);
        }
        else {
            const current = p._getAdjustedCurrentElement();
            const currentNs = p.treeAdapter.getNamespaceURI(current);
            if (currentNs === NS.MATHML) {
                adjustTokenMathMLAttrs(token);
            }
            else if (currentNs === NS.SVG) {
                adjustTokenSVGTagName(token);
                adjustTokenSVGAttrs(token);
            }
            adjustTokenXMLAttrs(token);
            if (token.selfClosing) {
                p._appendElement(token, currentNs);
            }
            else {
                p._insertElement(token, currentNs);
            }
            token.ackSelfClosing = true;
        }
    }
    function endTagInForeignContent(p, token) {
        if (token.tagID === TAG_ID.P || token.tagID === TAG_ID.BR) {
            popUntilHtmlOrIntegrationPoint(p);
            p._endTagOutsideForeignContent(token);
            return;
        }
        for (let i = p.openElements.stackTop; i > 0; i--) {
            const element = p.openElements.items[i];
            if (p.treeAdapter.getNamespaceURI(element) === NS.HTML) {
                p._endTagOutsideForeignContent(token);
                break;
            }
            const tagName = p.treeAdapter.getTagName(element);
            if (tagName.toLowerCase() === token.tagName) {
                //NOTE: update the token tag name for `_setEndLocation`.
                token.tagName = tagName;
                p.openElements.shortenToLength(i);
                break;
            }
        }
    }

    // Sets
    const VOID_ELEMENTS = new Set([
        TAG_NAMES.AREA,
        TAG_NAMES.BASE,
        TAG_NAMES.BASEFONT,
        TAG_NAMES.BGSOUND,
        TAG_NAMES.BR,
        TAG_NAMES.COL,
        TAG_NAMES.EMBED,
        TAG_NAMES.FRAME,
        TAG_NAMES.HR,
        TAG_NAMES.IMG,
        TAG_NAMES.INPUT,
        TAG_NAMES.KEYGEN,
        TAG_NAMES.LINK,
        TAG_NAMES.META,
        TAG_NAMES.PARAM,
        TAG_NAMES.SOURCE,
        TAG_NAMES.TRACK,
        TAG_NAMES.WBR,
    ]);
    function isVoidElement(node, options) {
        return (options.treeAdapter.isElementNode(node) &&
            options.treeAdapter.getNamespaceURI(node) === NS.HTML &&
            VOID_ELEMENTS.has(options.treeAdapter.getTagName(node)));
    }
    const defaultOpts = { treeAdapter: defaultTreeAdapter, scriptingEnabled: true };
    /**
     * Serializes an AST element node to an HTML string, including the element node.
     *
     * @example
     *
     * ```js
     * const parse5 = require('parse5');
     *
     * const document = parse5.parseFragment('<div>Hello, <b>world</b>!</div>');
     *
     * // Serializes the <div> element.
     * const html = parse5.serializeOuter(document.childNodes[0]);
     *
     * console.log(str); //> '<div>Hello, <b>world</b>!</div>'
     * ```
     *
     * @param node Node to serialize.
     * @param options Serialization options.
     */
    function serializeOuter(node, options) {
        const opts = { ...defaultOpts, ...options };
        return serializeNode(node, opts);
    }
    function serializeChildNodes(parentNode, options) {
        let html = '';
        // Get container of the child nodes
        const container = options.treeAdapter.isElementNode(parentNode) &&
            options.treeAdapter.getTagName(parentNode) === TAG_NAMES.TEMPLATE &&
            options.treeAdapter.getNamespaceURI(parentNode) === NS.HTML
            ? options.treeAdapter.getTemplateContent(parentNode)
            : parentNode;
        const childNodes = options.treeAdapter.getChildNodes(container);
        if (childNodes) {
            for (const currentNode of childNodes) {
                html += serializeNode(currentNode, options);
            }
        }
        return html;
    }
    function serializeNode(node, options) {
        if (options.treeAdapter.isElementNode(node)) {
            return serializeElement(node, options);
        }
        if (options.treeAdapter.isTextNode(node)) {
            return serializeTextNode(node, options);
        }
        if (options.treeAdapter.isCommentNode(node)) {
            return serializeCommentNode(node, options);
        }
        if (options.treeAdapter.isDocumentTypeNode(node)) {
            return serializeDocumentTypeNode(node, options);
        }
        // Return an empty string for unknown nodes
        return '';
    }
    function serializeElement(node, options) {
        const tn = options.treeAdapter.getTagName(node);
        return `<${tn}${serializeAttributes(node, options)}>${isVoidElement(node, options) ? '' : `${serializeChildNodes(node, options)}</${tn}>`}`;
    }
    function serializeAttributes(node, { treeAdapter }) {
        let html = '';
        for (const attr of treeAdapter.getAttrList(node)) {
            html += ' ';
            if (!attr.namespace) {
                html += attr.name;
            }
            else
                switch (attr.namespace) {
                    case NS.XML: {
                        html += `xml:${attr.name}`;
                        break;
                    }
                    case NS.XMLNS: {
                        if (attr.name !== 'xmlns') {
                            html += 'xmlns:';
                        }
                        html += attr.name;
                        break;
                    }
                    case NS.XLINK: {
                        html += `xlink:${attr.name}`;
                        break;
                    }
                    default: {
                        html += `${attr.prefix}:${attr.name}`;
                    }
                }
            html += `="${escapeAttribute(attr.value)}"`;
        }
        return html;
    }
    function serializeTextNode(node, options) {
        const { treeAdapter } = options;
        const content = treeAdapter.getTextNodeContent(node);
        const parent = treeAdapter.getParentNode(node);
        const parentTn = parent && treeAdapter.isElementNode(parent) && treeAdapter.getTagName(parent);
        return parentTn &&
            treeAdapter.getNamespaceURI(parent) === NS.HTML &&
            hasUnescapedText(parentTn, options.scriptingEnabled)
            ? content
            : escapeText(content);
    }
    function serializeCommentNode(node, { treeAdapter }) {
        return `<!--${treeAdapter.getCommentNodeContent(node)}-->`;
    }
    function serializeDocumentTypeNode(node, { treeAdapter }) {
        return `<!DOCTYPE ${treeAdapter.getDocumentTypeNodeName(node)}>`;
    }

    // Shorthands
    /**
     * Parses an HTML string.
     *
     * @param html Input HTML string.
     * @param options Parsing options.
     * @returns Document
     *
     * @example
     *
     * ```js
     * const parse5 = require('parse5');
     *
     * const document = parse5.parse('<!DOCTYPE html><html><head></head><body>Hi there!</body></html>');
     *
     * console.log(document.childNodes[1].tagName); //> 'html'
     *```
     */
    function parse$1(html, options) {
        return Parser$1.parse(html, options);
    }
    function parseFragment(fragmentContext, html, options) {
        if (typeof fragmentContext === 'string') {
            options = html;
            html = fragmentContext;
            fragmentContext = null;
        }
        const parser = Parser$1.getFragmentParser(fragmentContext, options);
        parser.tokenizer.write(html, true);
        return parser.getFragment();
    }

    function createTextNode(value) {
        return new Text(value);
    }
    function enquoteDoctypeId(id) {
        const quote = id.includes('"') ? "'" : '"';
        return quote + id + quote;
    }
    /** @internal */
    function serializeDoctypeContent(name, publicId, systemId) {
        let str = '!DOCTYPE ';
        if (name) {
            str += name;
        }
        if (publicId) {
            str += ` PUBLIC ${enquoteDoctypeId(publicId)}`;
        }
        else if (systemId) {
            str += ' SYSTEM';
        }
        if (systemId) {
            str += ` ${enquoteDoctypeId(systemId)}`;
        }
        return str;
    }
    const adapter = {
        // Re-exports from domhandler
        isCommentNode: isComment,
        isElementNode: isTag,
        isTextNode: isText,
        //Node construction
        createDocument() {
            const node = new Document([]);
            node['x-mode'] = DOCUMENT_MODE.NO_QUIRKS;
            return node;
        },
        createDocumentFragment() {
            return new Document([]);
        },
        createElement(tagName, namespaceURI, attrs) {
            const attribs = Object.create(null);
            const attribsNamespace = Object.create(null);
            const attribsPrefix = Object.create(null);
            for (let i = 0; i < attrs.length; i++) {
                const attrName = attrs[i].name;
                attribs[attrName] = attrs[i].value;
                attribsNamespace[attrName] = attrs[i].namespace;
                attribsPrefix[attrName] = attrs[i].prefix;
            }
            const node = new Element(tagName, attribs, []);
            node.namespace = namespaceURI;
            node['x-attribsNamespace'] = attribsNamespace;
            node['x-attribsPrefix'] = attribsPrefix;
            return node;
        },
        createCommentNode(data) {
            return new Comment(data);
        },
        //Tree mutation
        appendChild(parentNode, newNode) {
            const prev = parentNode.children[parentNode.children.length - 1];
            if (prev) {
                prev.next = newNode;
                newNode.prev = prev;
            }
            parentNode.children.push(newNode);
            newNode.parent = parentNode;
        },
        insertBefore(parentNode, newNode, referenceNode) {
            const insertionIdx = parentNode.children.indexOf(referenceNode);
            const { prev } = referenceNode;
            if (prev) {
                prev.next = newNode;
                newNode.prev = prev;
            }
            referenceNode.prev = newNode;
            newNode.next = referenceNode;
            parentNode.children.splice(insertionIdx, 0, newNode);
            newNode.parent = parentNode;
        },
        setTemplateContent(templateElement, contentElement) {
            adapter.appendChild(templateElement, contentElement);
        },
        getTemplateContent(templateElement) {
            return templateElement.children[0];
        },
        setDocumentType(document, name, publicId, systemId) {
            const data = serializeDoctypeContent(name, publicId, systemId);
            let doctypeNode = document.children.find((node) => isDirective(node) && node.name === '!doctype');
            if (doctypeNode) {
                doctypeNode.data = data !== null && data !== void 0 ? data : null;
            }
            else {
                doctypeNode = new ProcessingInstruction('!doctype', data);
                adapter.appendChild(document, doctypeNode);
            }
            doctypeNode['x-name'] = name !== null && name !== void 0 ? name : undefined;
            doctypeNode['x-publicId'] = publicId !== null && publicId !== void 0 ? publicId : undefined;
            doctypeNode['x-systemId'] = systemId !== null && systemId !== void 0 ? systemId : undefined;
        },
        setDocumentMode(document, mode) {
            document['x-mode'] = mode;
        },
        getDocumentMode(document) {
            return document['x-mode'];
        },
        detachNode(node) {
            if (node.parent) {
                const idx = node.parent.children.indexOf(node);
                const { prev, next } = node;
                node.prev = null;
                node.next = null;
                if (prev) {
                    prev.next = next;
                }
                if (next) {
                    next.prev = prev;
                }
                node.parent.children.splice(idx, 1);
                node.parent = null;
            }
        },
        insertText(parentNode, text) {
            const lastChild = parentNode.children[parentNode.children.length - 1];
            if (lastChild && isText(lastChild)) {
                lastChild.data += text;
            }
            else {
                adapter.appendChild(parentNode, createTextNode(text));
            }
        },
        insertTextBefore(parentNode, text, referenceNode) {
            const prevNode = parentNode.children[parentNode.children.indexOf(referenceNode) - 1];
            if (prevNode && isText(prevNode)) {
                prevNode.data += text;
            }
            else {
                adapter.insertBefore(parentNode, createTextNode(text), referenceNode);
            }
        },
        adoptAttributes(recipient, attrs) {
            for (let i = 0; i < attrs.length; i++) {
                const attrName = attrs[i].name;
                if (typeof recipient.attribs[attrName] === 'undefined') {
                    recipient.attribs[attrName] = attrs[i].value;
                    recipient['x-attribsNamespace'][attrName] = attrs[i].namespace;
                    recipient['x-attribsPrefix'][attrName] = attrs[i].prefix;
                }
            }
        },
        //Tree traversing
        getFirstChild(node) {
            return node.children[0];
        },
        getChildNodes(node) {
            return node.children;
        },
        getParentNode(node) {
            return node.parent;
        },
        getAttrList(element) {
            return element.attributes;
        },
        //Node data
        getTagName(element) {
            return element.name;
        },
        getNamespaceURI(element) {
            return element.namespace;
        },
        getTextNodeContent(textNode) {
            return textNode.data;
        },
        getCommentNodeContent(commentNode) {
            return commentNode.data;
        },
        getDocumentTypeNodeName(doctypeNode) {
            var _a;
            return (_a = doctypeNode['x-name']) !== null && _a !== void 0 ? _a : '';
        },
        getDocumentTypeNodePublicId(doctypeNode) {
            var _a;
            return (_a = doctypeNode['x-publicId']) !== null && _a !== void 0 ? _a : '';
        },
        getDocumentTypeNodeSystemId(doctypeNode) {
            var _a;
            return (_a = doctypeNode['x-systemId']) !== null && _a !== void 0 ? _a : '';
        },
        //Node types
        isDocumentTypeNode(node) {
            return isDirective(node) && node.name === '!doctype';
        },
        // Source code location
        setNodeSourceCodeLocation(node, location) {
            if (location) {
                node.startIndex = location.startOffset;
                node.endIndex = location.endOffset;
            }
            node.sourceCodeLocation = location;
        },
        getNodeSourceCodeLocation(node) {
            return node.sourceCodeLocation;
        },
        updateNodeSourceCodeLocation(node, endLocation) {
            if (endLocation.endOffset != null)
                node.endIndex = endLocation.endOffset;
            node.sourceCodeLocation = {
                ...node.sourceCodeLocation,
                ...endLocation,
            };
        },
    };

    /**
     * Parse the content with `parse5` in the context of the given `ParentNode`.
     *
     * @param content - The content to parse.
     * @param options - A set of options to use to parse.
     * @param isDocument - Whether to parse the content as a full HTML document.
     * @param context - The context in which to parse the content.
     * @returns The parsed content.
     */
    function parseWithParse5(content, options, isDocument, context) {
        const opts = {
            scriptingEnabled: typeof options.scriptingEnabled === 'boolean'
                ? options.scriptingEnabled
                : true,
            treeAdapter: adapter,
            sourceCodeLocationInfo: options.sourceCodeLocationInfo,
        };
        return isDocument
            ? parse$1(content, opts)
            : parseFragment(context, content, opts);
    }
    const renderOpts = { treeAdapter: adapter };
    /**
     * Renders the given DOM tree with `parse5` and returns the result as a string.
     *
     * @param dom - The DOM tree to render.
     * @returns The rendered document.
     */
    function renderWithParse5(dom) {
        /*
         * `dom-serializer` passes over the special "root" node and renders the
         * node's children in its place. To mimic this behavior with `parse5`, an
         * equivalent operation must be applied to the input array.
         */
        const nodes = 'length' in dom ? dom : [dom];
        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            if (isDocument(node)) {
                Array.prototype.splice.call(nodes, index, 1, ...node.children);
            }
        }
        let result = '';
        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            result += serializeOuter(node, renderOpts);
        }
        return result;
    }

    var CharCodes;
    (function (CharCodes) {
        CharCodes[CharCodes["Tab"] = 9] = "Tab";
        CharCodes[CharCodes["NewLine"] = 10] = "NewLine";
        CharCodes[CharCodes["FormFeed"] = 12] = "FormFeed";
        CharCodes[CharCodes["CarriageReturn"] = 13] = "CarriageReturn";
        CharCodes[CharCodes["Space"] = 32] = "Space";
        CharCodes[CharCodes["ExclamationMark"] = 33] = "ExclamationMark";
        CharCodes[CharCodes["Num"] = 35] = "Num";
        CharCodes[CharCodes["Amp"] = 38] = "Amp";
        CharCodes[CharCodes["SingleQuote"] = 39] = "SingleQuote";
        CharCodes[CharCodes["DoubleQuote"] = 34] = "DoubleQuote";
        CharCodes[CharCodes["Dash"] = 45] = "Dash";
        CharCodes[CharCodes["Slash"] = 47] = "Slash";
        CharCodes[CharCodes["Zero"] = 48] = "Zero";
        CharCodes[CharCodes["Nine"] = 57] = "Nine";
        CharCodes[CharCodes["Semi"] = 59] = "Semi";
        CharCodes[CharCodes["Lt"] = 60] = "Lt";
        CharCodes[CharCodes["Eq"] = 61] = "Eq";
        CharCodes[CharCodes["Gt"] = 62] = "Gt";
        CharCodes[CharCodes["Questionmark"] = 63] = "Questionmark";
        CharCodes[CharCodes["UpperA"] = 65] = "UpperA";
        CharCodes[CharCodes["LowerA"] = 97] = "LowerA";
        CharCodes[CharCodes["UpperF"] = 70] = "UpperF";
        CharCodes[CharCodes["LowerF"] = 102] = "LowerF";
        CharCodes[CharCodes["UpperZ"] = 90] = "UpperZ";
        CharCodes[CharCodes["LowerZ"] = 122] = "LowerZ";
        CharCodes[CharCodes["LowerX"] = 120] = "LowerX";
        CharCodes[CharCodes["OpeningSquareBracket"] = 91] = "OpeningSquareBracket";
    })(CharCodes || (CharCodes = {}));
    /** All the states the tokenizer can be in. */
    var State;
    (function (State) {
        State[State["Text"] = 1] = "Text";
        State[State["BeforeTagName"] = 2] = "BeforeTagName";
        State[State["InTagName"] = 3] = "InTagName";
        State[State["InSelfClosingTag"] = 4] = "InSelfClosingTag";
        State[State["BeforeClosingTagName"] = 5] = "BeforeClosingTagName";
        State[State["InClosingTagName"] = 6] = "InClosingTagName";
        State[State["AfterClosingTagName"] = 7] = "AfterClosingTagName";
        // Attributes
        State[State["BeforeAttributeName"] = 8] = "BeforeAttributeName";
        State[State["InAttributeName"] = 9] = "InAttributeName";
        State[State["AfterAttributeName"] = 10] = "AfterAttributeName";
        State[State["BeforeAttributeValue"] = 11] = "BeforeAttributeValue";
        State[State["InAttributeValueDq"] = 12] = "InAttributeValueDq";
        State[State["InAttributeValueSq"] = 13] = "InAttributeValueSq";
        State[State["InAttributeValueNq"] = 14] = "InAttributeValueNq";
        // Declarations
        State[State["BeforeDeclaration"] = 15] = "BeforeDeclaration";
        State[State["InDeclaration"] = 16] = "InDeclaration";
        // Processing instructions
        State[State["InProcessingInstruction"] = 17] = "InProcessingInstruction";
        // Comments & CDATA
        State[State["BeforeComment"] = 18] = "BeforeComment";
        State[State["CDATASequence"] = 19] = "CDATASequence";
        State[State["InSpecialComment"] = 20] = "InSpecialComment";
        State[State["InCommentLike"] = 21] = "InCommentLike";
        // Special tags
        State[State["BeforeSpecialS"] = 22] = "BeforeSpecialS";
        State[State["SpecialStartSequence"] = 23] = "SpecialStartSequence";
        State[State["InSpecialTag"] = 24] = "InSpecialTag";
        State[State["BeforeEntity"] = 25] = "BeforeEntity";
        State[State["BeforeNumericEntity"] = 26] = "BeforeNumericEntity";
        State[State["InNamedEntity"] = 27] = "InNamedEntity";
        State[State["InNumericEntity"] = 28] = "InNumericEntity";
        State[State["InHexEntity"] = 29] = "InHexEntity";
    })(State || (State = {}));
    function isWhitespace(c) {
        return (c === CharCodes.Space ||
            c === CharCodes.NewLine ||
            c === CharCodes.Tab ||
            c === CharCodes.FormFeed ||
            c === CharCodes.CarriageReturn);
    }
    function isEndOfTagSection(c) {
        return c === CharCodes.Slash || c === CharCodes.Gt || isWhitespace(c);
    }
    function isNumber(c) {
        return c >= CharCodes.Zero && c <= CharCodes.Nine;
    }
    function isASCIIAlpha(c) {
        return ((c >= CharCodes.LowerA && c <= CharCodes.LowerZ) ||
            (c >= CharCodes.UpperA && c <= CharCodes.UpperZ));
    }
    function isHexDigit(c) {
        return ((c >= CharCodes.UpperA && c <= CharCodes.UpperF) ||
            (c >= CharCodes.LowerA && c <= CharCodes.LowerF));
    }
    var QuoteType;
    (function (QuoteType) {
        QuoteType[QuoteType["NoValue"] = 0] = "NoValue";
        QuoteType[QuoteType["Unquoted"] = 1] = "Unquoted";
        QuoteType[QuoteType["Single"] = 2] = "Single";
        QuoteType[QuoteType["Double"] = 3] = "Double";
    })(QuoteType || (QuoteType = {}));
    /**
     * Sequences used to match longer strings.
     *
     * We don't have `Script`, `Style`, or `Title` here. Instead, we re-use the *End
     * sequences with an increased offset.
     */
    const Sequences = {
        Cdata: new Uint8Array([0x43, 0x44, 0x41, 0x54, 0x41, 0x5b]),
        CdataEnd: new Uint8Array([0x5d, 0x5d, 0x3e]),
        CommentEnd: new Uint8Array([0x2d, 0x2d, 0x3e]),
        ScriptEnd: new Uint8Array([0x3c, 0x2f, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74]),
        StyleEnd: new Uint8Array([0x3c, 0x2f, 0x73, 0x74, 0x79, 0x6c, 0x65]),
        TitleEnd: new Uint8Array([0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65]), // `</title`
    };
    class Tokenizer {
        constructor({ xmlMode = false, decodeEntities = true, }, cbs) {
            this.cbs = cbs;
            /** The current state the tokenizer is in. */
            this.state = State.Text;
            /** The read buffer. */
            this.buffer = "";
            /** The beginning of the section that is currently being read. */
            this.sectionStart = 0;
            /** The index within the buffer that we are currently looking at. */
            this.index = 0;
            /** Some behavior, eg. when decoding entities, is done while we are in another state. This keeps track of the other state type. */
            this.baseState = State.Text;
            /** For special parsing behavior inside of script and style tags. */
            this.isSpecial = false;
            /** Indicates whether the tokenizer has been paused. */
            this.running = true;
            /** The offset of the current buffer. */
            this.offset = 0;
            this.sequenceIndex = 0;
            this.trieIndex = 0;
            this.trieCurrent = 0;
            /** For named entities, the index of the value. For numeric entities, the code point. */
            this.entityResult = 0;
            this.entityExcess = 0;
            this.xmlMode = xmlMode;
            this.decodeEntities = decodeEntities;
            this.entityTrie = xmlMode ? xmlDecodeTree : htmlDecodeTree;
        }
        reset() {
            this.state = State.Text;
            this.buffer = "";
            this.sectionStart = 0;
            this.index = 0;
            this.baseState = State.Text;
            this.currentSequence = undefined;
            this.running = true;
            this.offset = 0;
        }
        write(chunk) {
            this.offset += this.buffer.length;
            this.buffer = chunk;
            this.parse();
        }
        end() {
            if (this.running)
                this.finish();
        }
        pause() {
            this.running = false;
        }
        resume() {
            this.running = true;
            if (this.index < this.buffer.length + this.offset) {
                this.parse();
            }
        }
        /**
         * The current index within all of the written data.
         */
        getIndex() {
            return this.index;
        }
        /**
         * The start of the current section.
         */
        getSectionStart() {
            return this.sectionStart;
        }
        stateText(c) {
            if (c === CharCodes.Lt ||
                (!this.decodeEntities && this.fastForwardTo(CharCodes.Lt))) {
                if (this.index > this.sectionStart) {
                    this.cbs.ontext(this.sectionStart, this.index);
                }
                this.state = State.BeforeTagName;
                this.sectionStart = this.index;
            }
            else if (this.decodeEntities && c === CharCodes.Amp) {
                this.state = State.BeforeEntity;
            }
        }
        stateSpecialStartSequence(c) {
            const isEnd = this.sequenceIndex === this.currentSequence.length;
            const isMatch = isEnd
                ? // If we are at the end of the sequence, make sure the tag name has ended
                    isEndOfTagSection(c)
                : // Otherwise, do a case-insensitive comparison
                    (c | 0x20) === this.currentSequence[this.sequenceIndex];
            if (!isMatch) {
                this.isSpecial = false;
            }
            else if (!isEnd) {
                this.sequenceIndex++;
                return;
            }
            this.sequenceIndex = 0;
            this.state = State.InTagName;
            this.stateInTagName(c);
        }
        /** Look for an end tag. For <title> tags, also decode entities. */
        stateInSpecialTag(c) {
            if (this.sequenceIndex === this.currentSequence.length) {
                if (c === CharCodes.Gt || isWhitespace(c)) {
                    const endOfText = this.index - this.currentSequence.length;
                    if (this.sectionStart < endOfText) {
                        // Spoof the index so that reported locations match up.
                        const actualIndex = this.index;
                        this.index = endOfText;
                        this.cbs.ontext(this.sectionStart, endOfText);
                        this.index = actualIndex;
                    }
                    this.isSpecial = false;
                    this.sectionStart = endOfText + 2; // Skip over the `</`
                    this.stateInClosingTagName(c);
                    return; // We are done; skip the rest of the function.
                }
                this.sequenceIndex = 0;
            }
            if ((c | 0x20) === this.currentSequence[this.sequenceIndex]) {
                this.sequenceIndex += 1;
            }
            else if (this.sequenceIndex === 0) {
                if (this.currentSequence === Sequences.TitleEnd) {
                    // We have to parse entities in <title> tags.
                    if (this.decodeEntities && c === CharCodes.Amp) {
                        this.state = State.BeforeEntity;
                    }
                }
                else if (this.fastForwardTo(CharCodes.Lt)) {
                    // Outside of <title> tags, we can fast-forward.
                    this.sequenceIndex = 1;
                }
            }
            else {
                // If we see a `<`, set the sequence index to 1; useful for eg. `<</script>`.
                this.sequenceIndex = Number(c === CharCodes.Lt);
            }
        }
        stateCDATASequence(c) {
            if (c === Sequences.Cdata[this.sequenceIndex]) {
                if (++this.sequenceIndex === Sequences.Cdata.length) {
                    this.state = State.InCommentLike;
                    this.currentSequence = Sequences.CdataEnd;
                    this.sequenceIndex = 0;
                    this.sectionStart = this.index + 1;
                }
            }
            else {
                this.sequenceIndex = 0;
                this.state = State.InDeclaration;
                this.stateInDeclaration(c); // Reconsume the character
            }
        }
        /**
         * When we wait for one specific character, we can speed things up
         * by skipping through the buffer until we find it.
         *
         * @returns Whether the character was found.
         */
        fastForwardTo(c) {
            while (++this.index < this.buffer.length + this.offset) {
                if (this.buffer.charCodeAt(this.index - this.offset) === c) {
                    return true;
                }
            }
            /*
             * We increment the index at the end of the `parse` loop,
             * so set it to `buffer.length - 1` here.
             *
             * TODO: Refactor `parse` to increment index before calling states.
             */
            this.index = this.buffer.length + this.offset - 1;
            return false;
        }
        /**
         * Comments and CDATA end with `-->` and `]]>`.
         *
         * Their common qualities are:
         * - Their end sequences have a distinct character they start with.
         * - That character is then repeated, so we have to check multiple repeats.
         * - All characters but the start character of the sequence can be skipped.
         */
        stateInCommentLike(c) {
            if (c === this.currentSequence[this.sequenceIndex]) {
                if (++this.sequenceIndex === this.currentSequence.length) {
                    if (this.currentSequence === Sequences.CdataEnd) {
                        this.cbs.oncdata(this.sectionStart, this.index, 2);
                    }
                    else {
                        this.cbs.oncomment(this.sectionStart, this.index, 2);
                    }
                    this.sequenceIndex = 0;
                    this.sectionStart = this.index + 1;
                    this.state = State.Text;
                }
            }
            else if (this.sequenceIndex === 0) {
                // Fast-forward to the first character of the sequence
                if (this.fastForwardTo(this.currentSequence[0])) {
                    this.sequenceIndex = 1;
                }
            }
            else if (c !== this.currentSequence[this.sequenceIndex - 1]) {
                // Allow long sequences, eg. --->, ]]]>
                this.sequenceIndex = 0;
            }
        }
        /**
         * HTML only allows ASCII alpha characters (a-z and A-Z) at the beginning of a tag name.
         *
         * XML allows a lot more characters here (@see https://www.w3.org/TR/REC-xml/#NT-NameStartChar).
         * We allow anything that wouldn't end the tag.
         */
        isTagStartChar(c) {
            return this.xmlMode ? !isEndOfTagSection(c) : isASCIIAlpha(c);
        }
        startSpecial(sequence, offset) {
            this.isSpecial = true;
            this.currentSequence = sequence;
            this.sequenceIndex = offset;
            this.state = State.SpecialStartSequence;
        }
        stateBeforeTagName(c) {
            if (c === CharCodes.ExclamationMark) {
                this.state = State.BeforeDeclaration;
                this.sectionStart = this.index + 1;
            }
            else if (c === CharCodes.Questionmark) {
                this.state = State.InProcessingInstruction;
                this.sectionStart = this.index + 1;
            }
            else if (this.isTagStartChar(c)) {
                const lower = c | 0x20;
                this.sectionStart = this.index;
                if (!this.xmlMode && lower === Sequences.TitleEnd[2]) {
                    this.startSpecial(Sequences.TitleEnd, 3);
                }
                else {
                    this.state =
                        !this.xmlMode && lower === Sequences.ScriptEnd[2]
                            ? State.BeforeSpecialS
                            : State.InTagName;
                }
            }
            else if (c === CharCodes.Slash) {
                this.state = State.BeforeClosingTagName;
            }
            else {
                this.state = State.Text;
                this.stateText(c);
            }
        }
        stateInTagName(c) {
            if (isEndOfTagSection(c)) {
                this.cbs.onopentagname(this.sectionStart, this.index);
                this.sectionStart = -1;
                this.state = State.BeforeAttributeName;
                this.stateBeforeAttributeName(c);
            }
        }
        stateBeforeClosingTagName(c) {
            if (isWhitespace(c)) ;
            else if (c === CharCodes.Gt) {
                this.state = State.Text;
            }
            else {
                this.state = this.isTagStartChar(c)
                    ? State.InClosingTagName
                    : State.InSpecialComment;
                this.sectionStart = this.index;
            }
        }
        stateInClosingTagName(c) {
            if (c === CharCodes.Gt || isWhitespace(c)) {
                this.cbs.onclosetag(this.sectionStart, this.index);
                this.sectionStart = -1;
                this.state = State.AfterClosingTagName;
                this.stateAfterClosingTagName(c);
            }
        }
        stateAfterClosingTagName(c) {
            // Skip everything until ">"
            if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
                this.state = State.Text;
                this.sectionStart = this.index + 1;
            }
        }
        stateBeforeAttributeName(c) {
            if (c === CharCodes.Gt) {
                this.cbs.onopentagend(this.index);
                if (this.isSpecial) {
                    this.state = State.InSpecialTag;
                    this.sequenceIndex = 0;
                }
                else {
                    this.state = State.Text;
                }
                this.baseState = this.state;
                this.sectionStart = this.index + 1;
            }
            else if (c === CharCodes.Slash) {
                this.state = State.InSelfClosingTag;
            }
            else if (!isWhitespace(c)) {
                this.state = State.InAttributeName;
                this.sectionStart = this.index;
            }
        }
        stateInSelfClosingTag(c) {
            if (c === CharCodes.Gt) {
                this.cbs.onselfclosingtag(this.index);
                this.state = State.Text;
                this.baseState = State.Text;
                this.sectionStart = this.index + 1;
                this.isSpecial = false; // Reset special state, in case of self-closing special tags
            }
            else if (!isWhitespace(c)) {
                this.state = State.BeforeAttributeName;
                this.stateBeforeAttributeName(c);
            }
        }
        stateInAttributeName(c) {
            if (c === CharCodes.Eq || isEndOfTagSection(c)) {
                this.cbs.onattribname(this.sectionStart, this.index);
                this.sectionStart = -1;
                this.state = State.AfterAttributeName;
                this.stateAfterAttributeName(c);
            }
        }
        stateAfterAttributeName(c) {
            if (c === CharCodes.Eq) {
                this.state = State.BeforeAttributeValue;
            }
            else if (c === CharCodes.Slash || c === CharCodes.Gt) {
                this.cbs.onattribend(QuoteType.NoValue, this.index);
                this.state = State.BeforeAttributeName;
                this.stateBeforeAttributeName(c);
            }
            else if (!isWhitespace(c)) {
                this.cbs.onattribend(QuoteType.NoValue, this.index);
                this.state = State.InAttributeName;
                this.sectionStart = this.index;
            }
        }
        stateBeforeAttributeValue(c) {
            if (c === CharCodes.DoubleQuote) {
                this.state = State.InAttributeValueDq;
                this.sectionStart = this.index + 1;
            }
            else if (c === CharCodes.SingleQuote) {
                this.state = State.InAttributeValueSq;
                this.sectionStart = this.index + 1;
            }
            else if (!isWhitespace(c)) {
                this.sectionStart = this.index;
                this.state = State.InAttributeValueNq;
                this.stateInAttributeValueNoQuotes(c); // Reconsume token
            }
        }
        handleInAttributeValue(c, quote) {
            if (c === quote ||
                (!this.decodeEntities && this.fastForwardTo(quote))) {
                this.cbs.onattribdata(this.sectionStart, this.index);
                this.sectionStart = -1;
                this.cbs.onattribend(quote === CharCodes.DoubleQuote
                    ? QuoteType.Double
                    : QuoteType.Single, this.index);
                this.state = State.BeforeAttributeName;
            }
            else if (this.decodeEntities && c === CharCodes.Amp) {
                this.baseState = this.state;
                this.state = State.BeforeEntity;
            }
        }
        stateInAttributeValueDoubleQuotes(c) {
            this.handleInAttributeValue(c, CharCodes.DoubleQuote);
        }
        stateInAttributeValueSingleQuotes(c) {
            this.handleInAttributeValue(c, CharCodes.SingleQuote);
        }
        stateInAttributeValueNoQuotes(c) {
            if (isWhitespace(c) || c === CharCodes.Gt) {
                this.cbs.onattribdata(this.sectionStart, this.index);
                this.sectionStart = -1;
                this.cbs.onattribend(QuoteType.Unquoted, this.index);
                this.state = State.BeforeAttributeName;
                this.stateBeforeAttributeName(c);
            }
            else if (this.decodeEntities && c === CharCodes.Amp) {
                this.baseState = this.state;
                this.state = State.BeforeEntity;
            }
        }
        stateBeforeDeclaration(c) {
            if (c === CharCodes.OpeningSquareBracket) {
                this.state = State.CDATASequence;
                this.sequenceIndex = 0;
            }
            else {
                this.state =
                    c === CharCodes.Dash
                        ? State.BeforeComment
                        : State.InDeclaration;
            }
        }
        stateInDeclaration(c) {
            if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
                this.cbs.ondeclaration(this.sectionStart, this.index);
                this.state = State.Text;
                this.sectionStart = this.index + 1;
            }
        }
        stateInProcessingInstruction(c) {
            if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
                this.cbs.onprocessinginstruction(this.sectionStart, this.index);
                this.state = State.Text;
                this.sectionStart = this.index + 1;
            }
        }
        stateBeforeComment(c) {
            if (c === CharCodes.Dash) {
                this.state = State.InCommentLike;
                this.currentSequence = Sequences.CommentEnd;
                // Allow short comments (eg. <!-->)
                this.sequenceIndex = 2;
                this.sectionStart = this.index + 1;
            }
            else {
                this.state = State.InDeclaration;
            }
        }
        stateInSpecialComment(c) {
            if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
                this.cbs.oncomment(this.sectionStart, this.index, 0);
                this.state = State.Text;
                this.sectionStart = this.index + 1;
            }
        }
        stateBeforeSpecialS(c) {
            const lower = c | 0x20;
            if (lower === Sequences.ScriptEnd[3]) {
                this.startSpecial(Sequences.ScriptEnd, 4);
            }
            else if (lower === Sequences.StyleEnd[3]) {
                this.startSpecial(Sequences.StyleEnd, 4);
            }
            else {
                this.state = State.InTagName;
                this.stateInTagName(c); // Consume the token again
            }
        }
        stateBeforeEntity(c) {
            // Start excess with 1 to include the '&'
            this.entityExcess = 1;
            this.entityResult = 0;
            if (c === CharCodes.Num) {
                this.state = State.BeforeNumericEntity;
            }
            else if (c === CharCodes.Amp) ;
            else {
                this.trieIndex = 0;
                this.trieCurrent = this.entityTrie[0];
                this.state = State.InNamedEntity;
                this.stateInNamedEntity(c);
            }
        }
        stateInNamedEntity(c) {
            this.entityExcess += 1;
            this.trieIndex = determineBranch(this.entityTrie, this.trieCurrent, this.trieIndex + 1, c);
            if (this.trieIndex < 0) {
                this.emitNamedEntity();
                this.index--;
                return;
            }
            this.trieCurrent = this.entityTrie[this.trieIndex];
            const masked = this.trieCurrent & BinTrieFlags.VALUE_LENGTH;
            // If the branch is a value, store it and continue
            if (masked) {
                // The mask is the number of bytes of the value, including the current byte.
                const valueLength = (masked >> 14) - 1;
                // If we have a legacy entity while parsing strictly, just skip the number of bytes
                if (!this.allowLegacyEntity() && c !== CharCodes.Semi) {
                    this.trieIndex += valueLength;
                }
                else {
                    // Add 1 as we have already incremented the excess
                    const entityStart = this.index - this.entityExcess + 1;
                    if (entityStart > this.sectionStart) {
                        this.emitPartial(this.sectionStart, entityStart);
                    }
                    // If this is a surrogate pair, consume the next two bytes
                    this.entityResult = this.trieIndex;
                    this.trieIndex += valueLength;
                    this.entityExcess = 0;
                    this.sectionStart = this.index + 1;
                    if (valueLength === 0) {
                        this.emitNamedEntity();
                    }
                }
            }
        }
        emitNamedEntity() {
            this.state = this.baseState;
            if (this.entityResult === 0) {
                return;
            }
            const valueLength = (this.entityTrie[this.entityResult] & BinTrieFlags.VALUE_LENGTH) >>
                14;
            switch (valueLength) {
                case 1:
                    this.emitCodePoint(this.entityTrie[this.entityResult] &
                        ~BinTrieFlags.VALUE_LENGTH);
                    break;
                case 2:
                    this.emitCodePoint(this.entityTrie[this.entityResult + 1]);
                    break;
                case 3: {
                    this.emitCodePoint(this.entityTrie[this.entityResult + 1]);
                    this.emitCodePoint(this.entityTrie[this.entityResult + 2]);
                }
            }
        }
        stateBeforeNumericEntity(c) {
            if ((c | 0x20) === CharCodes.LowerX) {
                this.entityExcess++;
                this.state = State.InHexEntity;
            }
            else {
                this.state = State.InNumericEntity;
                this.stateInNumericEntity(c);
            }
        }
        emitNumericEntity(strict) {
            const entityStart = this.index - this.entityExcess - 1;
            const numberStart = entityStart + 2 + Number(this.state === State.InHexEntity);
            if (numberStart !== this.index) {
                // Emit leading data if any
                if (entityStart > this.sectionStart) {
                    this.emitPartial(this.sectionStart, entityStart);
                }
                this.sectionStart = this.index + Number(strict);
                this.emitCodePoint(replaceCodePoint(this.entityResult));
            }
            this.state = this.baseState;
        }
        stateInNumericEntity(c) {
            if (c === CharCodes.Semi) {
                this.emitNumericEntity(true);
            }
            else if (isNumber(c)) {
                this.entityResult = this.entityResult * 10 + (c - CharCodes.Zero);
                this.entityExcess++;
            }
            else {
                if (this.allowLegacyEntity()) {
                    this.emitNumericEntity(false);
                }
                else {
                    this.state = this.baseState;
                }
                this.index--;
            }
        }
        stateInHexEntity(c) {
            if (c === CharCodes.Semi) {
                this.emitNumericEntity(true);
            }
            else if (isNumber(c)) {
                this.entityResult = this.entityResult * 16 + (c - CharCodes.Zero);
                this.entityExcess++;
            }
            else if (isHexDigit(c)) {
                this.entityResult =
                    this.entityResult * 16 + ((c | 0x20) - CharCodes.LowerA + 10);
                this.entityExcess++;
            }
            else {
                if (this.allowLegacyEntity()) {
                    this.emitNumericEntity(false);
                }
                else {
                    this.state = this.baseState;
                }
                this.index--;
            }
        }
        allowLegacyEntity() {
            return (!this.xmlMode &&
                (this.baseState === State.Text ||
                    this.baseState === State.InSpecialTag));
        }
        /**
         * Remove data that has already been consumed from the buffer.
         */
        cleanup() {
            // If we are inside of text or attributes, emit what we already have.
            if (this.running && this.sectionStart !== this.index) {
                if (this.state === State.Text ||
                    (this.state === State.InSpecialTag && this.sequenceIndex === 0)) {
                    this.cbs.ontext(this.sectionStart, this.index);
                    this.sectionStart = this.index;
                }
                else if (this.state === State.InAttributeValueDq ||
                    this.state === State.InAttributeValueSq ||
                    this.state === State.InAttributeValueNq) {
                    this.cbs.onattribdata(this.sectionStart, this.index);
                    this.sectionStart = this.index;
                }
            }
        }
        shouldContinue() {
            return this.index < this.buffer.length + this.offset && this.running;
        }
        /**
         * Iterates through the buffer, calling the function corresponding to the current state.
         *
         * States that are more likely to be hit are higher up, as a performance improvement.
         */
        parse() {
            while (this.shouldContinue()) {
                const c = this.buffer.charCodeAt(this.index - this.offset);
                if (this.state === State.Text) {
                    this.stateText(c);
                }
                else if (this.state === State.SpecialStartSequence) {
                    this.stateSpecialStartSequence(c);
                }
                else if (this.state === State.InSpecialTag) {
                    this.stateInSpecialTag(c);
                }
                else if (this.state === State.CDATASequence) {
                    this.stateCDATASequence(c);
                }
                else if (this.state === State.InAttributeValueDq) {
                    this.stateInAttributeValueDoubleQuotes(c);
                }
                else if (this.state === State.InAttributeName) {
                    this.stateInAttributeName(c);
                }
                else if (this.state === State.InCommentLike) {
                    this.stateInCommentLike(c);
                }
                else if (this.state === State.InSpecialComment) {
                    this.stateInSpecialComment(c);
                }
                else if (this.state === State.BeforeAttributeName) {
                    this.stateBeforeAttributeName(c);
                }
                else if (this.state === State.InTagName) {
                    this.stateInTagName(c);
                }
                else if (this.state === State.InClosingTagName) {
                    this.stateInClosingTagName(c);
                }
                else if (this.state === State.BeforeTagName) {
                    this.stateBeforeTagName(c);
                }
                else if (this.state === State.AfterAttributeName) {
                    this.stateAfterAttributeName(c);
                }
                else if (this.state === State.InAttributeValueSq) {
                    this.stateInAttributeValueSingleQuotes(c);
                }
                else if (this.state === State.BeforeAttributeValue) {
                    this.stateBeforeAttributeValue(c);
                }
                else if (this.state === State.BeforeClosingTagName) {
                    this.stateBeforeClosingTagName(c);
                }
                else if (this.state === State.AfterClosingTagName) {
                    this.stateAfterClosingTagName(c);
                }
                else if (this.state === State.BeforeSpecialS) {
                    this.stateBeforeSpecialS(c);
                }
                else if (this.state === State.InAttributeValueNq) {
                    this.stateInAttributeValueNoQuotes(c);
                }
                else if (this.state === State.InSelfClosingTag) {
                    this.stateInSelfClosingTag(c);
                }
                else if (this.state === State.InDeclaration) {
                    this.stateInDeclaration(c);
                }
                else if (this.state === State.BeforeDeclaration) {
                    this.stateBeforeDeclaration(c);
                }
                else if (this.state === State.BeforeComment) {
                    this.stateBeforeComment(c);
                }
                else if (this.state === State.InProcessingInstruction) {
                    this.stateInProcessingInstruction(c);
                }
                else if (this.state === State.InNamedEntity) {
                    this.stateInNamedEntity(c);
                }
                else if (this.state === State.BeforeEntity) {
                    this.stateBeforeEntity(c);
                }
                else if (this.state === State.InHexEntity) {
                    this.stateInHexEntity(c);
                }
                else if (this.state === State.InNumericEntity) {
                    this.stateInNumericEntity(c);
                }
                else {
                    // `this._state === State.BeforeNumericEntity`
                    this.stateBeforeNumericEntity(c);
                }
                this.index++;
            }
            this.cleanup();
        }
        finish() {
            if (this.state === State.InNamedEntity) {
                this.emitNamedEntity();
            }
            // If there is remaining data, emit it in a reasonable way
            if (this.sectionStart < this.index) {
                this.handleTrailingData();
            }
            this.cbs.onend();
        }
        /** Handle any trailing data. */
        handleTrailingData() {
            const endIndex = this.buffer.length + this.offset;
            if (this.state === State.InCommentLike) {
                if (this.currentSequence === Sequences.CdataEnd) {
                    this.cbs.oncdata(this.sectionStart, endIndex, 0);
                }
                else {
                    this.cbs.oncomment(this.sectionStart, endIndex, 0);
                }
            }
            else if (this.state === State.InNumericEntity &&
                this.allowLegacyEntity()) {
                this.emitNumericEntity(false);
                // All trailing data will have been consumed
            }
            else if (this.state === State.InHexEntity &&
                this.allowLegacyEntity()) {
                this.emitNumericEntity(false);
                // All trailing data will have been consumed
            }
            else if (this.state === State.InTagName ||
                this.state === State.BeforeAttributeName ||
                this.state === State.BeforeAttributeValue ||
                this.state === State.AfterAttributeName ||
                this.state === State.InAttributeName ||
                this.state === State.InAttributeValueSq ||
                this.state === State.InAttributeValueDq ||
                this.state === State.InAttributeValueNq ||
                this.state === State.InClosingTagName) ;
            else {
                this.cbs.ontext(this.sectionStart, endIndex);
            }
        }
        emitPartial(start, endIndex) {
            if (this.baseState !== State.Text &&
                this.baseState !== State.InSpecialTag) {
                this.cbs.onattribdata(start, endIndex);
            }
            else {
                this.cbs.ontext(start, endIndex);
            }
        }
        emitCodePoint(cp) {
            if (this.baseState !== State.Text &&
                this.baseState !== State.InSpecialTag) {
                this.cbs.onattribentity(cp);
            }
            else {
                this.cbs.ontextentity(cp);
            }
        }
    }

    const formTags = new Set([
        "input",
        "option",
        "optgroup",
        "select",
        "button",
        "datalist",
        "textarea",
    ]);
    const pTag = new Set(["p"]);
    const tableSectionTags = new Set(["thead", "tbody"]);
    const ddtTags = new Set(["dd", "dt"]);
    const rtpTags = new Set(["rt", "rp"]);
    const openImpliesClose = new Map([
        ["tr", new Set(["tr", "th", "td"])],
        ["th", new Set(["th"])],
        ["td", new Set(["thead", "th", "td"])],
        ["body", new Set(["head", "link", "script"])],
        ["li", new Set(["li"])],
        ["p", pTag],
        ["h1", pTag],
        ["h2", pTag],
        ["h3", pTag],
        ["h4", pTag],
        ["h5", pTag],
        ["h6", pTag],
        ["select", formTags],
        ["input", formTags],
        ["output", formTags],
        ["button", formTags],
        ["datalist", formTags],
        ["textarea", formTags],
        ["option", new Set(["option"])],
        ["optgroup", new Set(["optgroup", "option"])],
        ["dd", ddtTags],
        ["dt", ddtTags],
        ["address", pTag],
        ["article", pTag],
        ["aside", pTag],
        ["blockquote", pTag],
        ["details", pTag],
        ["div", pTag],
        ["dl", pTag],
        ["fieldset", pTag],
        ["figcaption", pTag],
        ["figure", pTag],
        ["footer", pTag],
        ["form", pTag],
        ["header", pTag],
        ["hr", pTag],
        ["main", pTag],
        ["nav", pTag],
        ["ol", pTag],
        ["pre", pTag],
        ["section", pTag],
        ["table", pTag],
        ["ul", pTag],
        ["rt", rtpTags],
        ["rp", rtpTags],
        ["tbody", tableSectionTags],
        ["tfoot", tableSectionTags],
    ]);
    const voidElements = new Set([
        "area",
        "base",
        "basefont",
        "br",
        "col",
        "command",
        "embed",
        "frame",
        "hr",
        "img",
        "input",
        "isindex",
        "keygen",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    ]);
    const foreignContextElements = new Set(["math", "svg"]);
    const htmlIntegrationElements = new Set([
        "mi",
        "mo",
        "mn",
        "ms",
        "mtext",
        "annotation-xml",
        "foreignobject",
        "desc",
        "title",
    ]);
    const reNameEnd = /\s|\//;
    class Parser {
        constructor(cbs, options = {}) {
            var _a, _b, _c, _d, _e;
            this.options = options;
            /** The start index of the last event. */
            this.startIndex = 0;
            /** The end index of the last event. */
            this.endIndex = 0;
            /**
             * Store the start index of the current open tag,
             * so we can update the start index for attributes.
             */
            this.openTagStart = 0;
            this.tagname = "";
            this.attribname = "";
            this.attribvalue = "";
            this.attribs = null;
            this.stack = [];
            this.foreignContext = [];
            this.buffers = [];
            this.bufferOffset = 0;
            /** The index of the last written buffer. Used when resuming after a `pause()`. */
            this.writeIndex = 0;
            /** Indicates whether the parser has finished running / `.end` has been called. */
            this.ended = false;
            this.cbs = cbs !== null && cbs !== void 0 ? cbs : {};
            this.lowerCaseTagNames = (_a = options.lowerCaseTags) !== null && _a !== void 0 ? _a : !options.xmlMode;
            this.lowerCaseAttributeNames =
                (_b = options.lowerCaseAttributeNames) !== null && _b !== void 0 ? _b : !options.xmlMode;
            this.tokenizer = new ((_c = options.Tokenizer) !== null && _c !== void 0 ? _c : Tokenizer)(this.options, this);
            (_e = (_d = this.cbs).onparserinit) === null || _e === void 0 ? void 0 : _e.call(_d, this);
        }
        // Tokenizer event handlers
        /** @internal */
        ontext(start, endIndex) {
            var _a, _b;
            const data = this.getSlice(start, endIndex);
            this.endIndex = endIndex - 1;
            (_b = (_a = this.cbs).ontext) === null || _b === void 0 ? void 0 : _b.call(_a, data);
            this.startIndex = endIndex;
        }
        /** @internal */
        ontextentity(cp) {
            var _a, _b;
            /*
             * Entities can be emitted on the character, or directly after.
             * We use the section start here to get accurate indices.
             */
            const idx = this.tokenizer.getSectionStart();
            this.endIndex = idx - 1;
            (_b = (_a = this.cbs).ontext) === null || _b === void 0 ? void 0 : _b.call(_a, fromCodePoint(cp));
            this.startIndex = idx;
        }
        isVoidElement(name) {
            return !this.options.xmlMode && voidElements.has(name);
        }
        /** @internal */
        onopentagname(start, endIndex) {
            this.endIndex = endIndex;
            let name = this.getSlice(start, endIndex);
            if (this.lowerCaseTagNames) {
                name = name.toLowerCase();
            }
            this.emitOpenTag(name);
        }
        emitOpenTag(name) {
            var _a, _b, _c, _d;
            this.openTagStart = this.startIndex;
            this.tagname = name;
            const impliesClose = !this.options.xmlMode && openImpliesClose.get(name);
            if (impliesClose) {
                while (this.stack.length > 0 &&
                    impliesClose.has(this.stack[this.stack.length - 1])) {
                    const el = this.stack.pop();
                    (_b = (_a = this.cbs).onclosetag) === null || _b === void 0 ? void 0 : _b.call(_a, el, true);
                }
            }
            if (!this.isVoidElement(name)) {
                this.stack.push(name);
                if (foreignContextElements.has(name)) {
                    this.foreignContext.push(true);
                }
                else if (htmlIntegrationElements.has(name)) {
                    this.foreignContext.push(false);
                }
            }
            (_d = (_c = this.cbs).onopentagname) === null || _d === void 0 ? void 0 : _d.call(_c, name);
            if (this.cbs.onopentag)
                this.attribs = {};
        }
        endOpenTag(isImplied) {
            var _a, _b;
            this.startIndex = this.openTagStart;
            if (this.attribs) {
                (_b = (_a = this.cbs).onopentag) === null || _b === void 0 ? void 0 : _b.call(_a, this.tagname, this.attribs, isImplied);
                this.attribs = null;
            }
            if (this.cbs.onclosetag && this.isVoidElement(this.tagname)) {
                this.cbs.onclosetag(this.tagname, true);
            }
            this.tagname = "";
        }
        /** @internal */
        onopentagend(endIndex) {
            this.endIndex = endIndex;
            this.endOpenTag(false);
            // Set `startIndex` for next node
            this.startIndex = endIndex + 1;
        }
        /** @internal */
        onclosetag(start, endIndex) {
            var _a, _b, _c, _d, _e, _f;
            this.endIndex = endIndex;
            let name = this.getSlice(start, endIndex);
            if (this.lowerCaseTagNames) {
                name = name.toLowerCase();
            }
            if (foreignContextElements.has(name) ||
                htmlIntegrationElements.has(name)) {
                this.foreignContext.pop();
            }
            if (!this.isVoidElement(name)) {
                const pos = this.stack.lastIndexOf(name);
                if (pos !== -1) {
                    if (this.cbs.onclosetag) {
                        let count = this.stack.length - pos;
                        while (count--) {
                            // We know the stack has sufficient elements.
                            this.cbs.onclosetag(this.stack.pop(), count !== 0);
                        }
                    }
                    else
                        this.stack.length = pos;
                }
                else if (!this.options.xmlMode && name === "p") {
                    // Implicit open before close
                    this.emitOpenTag("p");
                    this.closeCurrentTag(true);
                }
            }
            else if (!this.options.xmlMode && name === "br") {
                // We can't use `emitOpenTag` for implicit open, as `br` would be implicitly closed.
                (_b = (_a = this.cbs).onopentagname) === null || _b === void 0 ? void 0 : _b.call(_a, "br");
                (_d = (_c = this.cbs).onopentag) === null || _d === void 0 ? void 0 : _d.call(_c, "br", {}, true);
                (_f = (_e = this.cbs).onclosetag) === null || _f === void 0 ? void 0 : _f.call(_e, "br", false);
            }
            // Set `startIndex` for next node
            this.startIndex = endIndex + 1;
        }
        /** @internal */
        onselfclosingtag(endIndex) {
            this.endIndex = endIndex;
            if (this.options.xmlMode ||
                this.options.recognizeSelfClosing ||
                this.foreignContext[this.foreignContext.length - 1]) {
                this.closeCurrentTag(false);
                // Set `startIndex` for next node
                this.startIndex = endIndex + 1;
            }
            else {
                // Ignore the fact that the tag is self-closing.
                this.onopentagend(endIndex);
            }
        }
        closeCurrentTag(isOpenImplied) {
            var _a, _b;
            const name = this.tagname;
            this.endOpenTag(isOpenImplied);
            // Self-closing tags will be on the top of the stack
            if (this.stack[this.stack.length - 1] === name) {
                // If the opening tag isn't implied, the closing tag has to be implied.
                (_b = (_a = this.cbs).onclosetag) === null || _b === void 0 ? void 0 : _b.call(_a, name, !isOpenImplied);
                this.stack.pop();
            }
        }
        /** @internal */
        onattribname(start, endIndex) {
            this.startIndex = start;
            const name = this.getSlice(start, endIndex);
            this.attribname = this.lowerCaseAttributeNames
                ? name.toLowerCase()
                : name;
        }
        /** @internal */
        onattribdata(start, endIndex) {
            this.attribvalue += this.getSlice(start, endIndex);
        }
        /** @internal */
        onattribentity(cp) {
            this.attribvalue += fromCodePoint(cp);
        }
        /** @internal */
        onattribend(quote, endIndex) {
            var _a, _b;
            this.endIndex = endIndex;
            (_b = (_a = this.cbs).onattribute) === null || _b === void 0 ? void 0 : _b.call(_a, this.attribname, this.attribvalue, quote === QuoteType.Double
                ? '"'
                : quote === QuoteType.Single
                    ? "'"
                    : quote === QuoteType.NoValue
                        ? undefined
                        : null);
            if (this.attribs &&
                !Object.prototype.hasOwnProperty.call(this.attribs, this.attribname)) {
                this.attribs[this.attribname] = this.attribvalue;
            }
            this.attribvalue = "";
        }
        getInstructionName(value) {
            const idx = value.search(reNameEnd);
            let name = idx < 0 ? value : value.substr(0, idx);
            if (this.lowerCaseTagNames) {
                name = name.toLowerCase();
            }
            return name;
        }
        /** @internal */
        ondeclaration(start, endIndex) {
            this.endIndex = endIndex;
            const value = this.getSlice(start, endIndex);
            if (this.cbs.onprocessinginstruction) {
                const name = this.getInstructionName(value);
                this.cbs.onprocessinginstruction(`!${name}`, `!${value}`);
            }
            // Set `startIndex` for next node
            this.startIndex = endIndex + 1;
        }
        /** @internal */
        onprocessinginstruction(start, endIndex) {
            this.endIndex = endIndex;
            const value = this.getSlice(start, endIndex);
            if (this.cbs.onprocessinginstruction) {
                const name = this.getInstructionName(value);
                this.cbs.onprocessinginstruction(`?${name}`, `?${value}`);
            }
            // Set `startIndex` for next node
            this.startIndex = endIndex + 1;
        }
        /** @internal */
        oncomment(start, endIndex, offset) {
            var _a, _b, _c, _d;
            this.endIndex = endIndex;
            (_b = (_a = this.cbs).oncomment) === null || _b === void 0 ? void 0 : _b.call(_a, this.getSlice(start, endIndex - offset));
            (_d = (_c = this.cbs).oncommentend) === null || _d === void 0 ? void 0 : _d.call(_c);
            // Set `startIndex` for next node
            this.startIndex = endIndex + 1;
        }
        /** @internal */
        oncdata(start, endIndex, offset) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
            this.endIndex = endIndex;
            const value = this.getSlice(start, endIndex - offset);
            if (this.options.xmlMode || this.options.recognizeCDATA) {
                (_b = (_a = this.cbs).oncdatastart) === null || _b === void 0 ? void 0 : _b.call(_a);
                (_d = (_c = this.cbs).ontext) === null || _d === void 0 ? void 0 : _d.call(_c, value);
                (_f = (_e = this.cbs).oncdataend) === null || _f === void 0 ? void 0 : _f.call(_e);
            }
            else {
                (_h = (_g = this.cbs).oncomment) === null || _h === void 0 ? void 0 : _h.call(_g, `[CDATA[${value}]]`);
                (_k = (_j = this.cbs).oncommentend) === null || _k === void 0 ? void 0 : _k.call(_j);
            }
            // Set `startIndex` for next node
            this.startIndex = endIndex + 1;
        }
        /** @internal */
        onend() {
            var _a, _b;
            if (this.cbs.onclosetag) {
                // Set the end index for all remaining tags
                this.endIndex = this.startIndex;
                for (let i = this.stack.length; i > 0; this.cbs.onclosetag(this.stack[--i], true))
                    ;
            }
            (_b = (_a = this.cbs).onend) === null || _b === void 0 ? void 0 : _b.call(_a);
        }
        /**
         * Resets the parser to a blank state, ready to parse a new HTML document
         */
        reset() {
            var _a, _b, _c, _d;
            (_b = (_a = this.cbs).onreset) === null || _b === void 0 ? void 0 : _b.call(_a);
            this.tokenizer.reset();
            this.tagname = "";
            this.attribname = "";
            this.attribs = null;
            this.stack.length = 0;
            this.startIndex = 0;
            this.endIndex = 0;
            (_d = (_c = this.cbs).onparserinit) === null || _d === void 0 ? void 0 : _d.call(_c, this);
            this.buffers.length = 0;
            this.bufferOffset = 0;
            this.writeIndex = 0;
            this.ended = false;
        }
        /**
         * Resets the parser, then parses a complete document and
         * pushes it to the handler.
         *
         * @param data Document to parse.
         */
        parseComplete(data) {
            this.reset();
            this.end(data);
        }
        getSlice(start, end) {
            while (start - this.bufferOffset >= this.buffers[0].length) {
                this.shiftBuffer();
            }
            let str = this.buffers[0].slice(start - this.bufferOffset, end - this.bufferOffset);
            while (end - this.bufferOffset > this.buffers[0].length) {
                this.shiftBuffer();
                str += this.buffers[0].slice(0, end - this.bufferOffset);
            }
            return str;
        }
        shiftBuffer() {
            this.bufferOffset += this.buffers[0].length;
            this.writeIndex--;
            this.buffers.shift();
        }
        /**
         * Parses a chunk of data and calls the corresponding callbacks.
         *
         * @param chunk Chunk to parse.
         */
        write(chunk) {
            var _a, _b;
            if (this.ended) {
                (_b = (_a = this.cbs).onerror) === null || _b === void 0 ? void 0 : _b.call(_a, new Error(".write() after done!"));
                return;
            }
            this.buffers.push(chunk);
            if (this.tokenizer.running) {
                this.tokenizer.write(chunk);
                this.writeIndex++;
            }
        }
        /**
         * Parses the end of the buffer and clears the stack, calls onend.
         *
         * @param chunk Optional final chunk to parse.
         */
        end(chunk) {
            var _a, _b;
            if (this.ended) {
                (_b = (_a = this.cbs).onerror) === null || _b === void 0 ? void 0 : _b.call(_a, Error(".end() after done!"));
                return;
            }
            if (chunk)
                this.write(chunk);
            this.ended = true;
            this.tokenizer.end();
        }
        /**
         * Pauses parsing. The parser won't emit events until `resume` is called.
         */
        pause() {
            this.tokenizer.pause();
        }
        /**
         * Resumes parsing after `pause` was called.
         */
        resume() {
            this.tokenizer.resume();
            while (this.tokenizer.running &&
                this.writeIndex < this.buffers.length) {
                this.tokenizer.write(this.buffers[this.writeIndex++]);
            }
            if (this.ended)
                this.tokenizer.end();
        }
        /**
         * Alias of `write`, for backwards compatibility.
         *
         * @param chunk Chunk to parse.
         * @deprecated
         */
        parseChunk(chunk) {
            this.write(chunk);
        }
        /**
         * Alias of `end`, for backwards compatibility.
         *
         * @param chunk Optional final chunk to parse.
         * @deprecated
         */
        done(chunk) {
            this.end(chunk);
        }
    }

    // Helper methods
    /**
     * Parses the data, returns the resulting document.
     *
     * @param data The data that should be parsed.
     * @param options Optional options for the parser and DOM builder.
     */
    function parseDocument(data, options) {
        const handler = new DomHandler(undefined, options);
        new Parser(handler, options).end(data);
        return handler.root;
    }

    /**
     * Types used in signatures of Cheerio methods.
     *
     * @category Cheerio
     */
    const parse = getParse((content, options, isDocument, context) => options.xmlMode || options._useHtmlParser2
        ? parseDocument(content, options)
        : parseWithParse5(content, options, isDocument, context));
    // Duplicate docs due to https://github.com/TypeStrong/typedoc/issues/1616
    /**
     * Create a querying function, bound to a document created from the provided markup.
     *
     * Note that similar to web browser contexts, this operation may introduce
     * `<html>`, `<head>`, and `<body>` elements; set `isDocument` to `false` to
     * switch to fragment mode and disable this.
     *
     * @param content - Markup to be loaded.
     * @param options - Options for the created instance.
     * @param isDocument - Allows parser to be switched to fragment mode.
     * @returns The loaded document.
     * @see {@link https://cheerio.js.org#loading} for additional usage information.
     */
    const load = getLoad(parse, (dom, options) => options.xmlMode || options._useHtmlParser2
        ? render$1(dom, options)
        : renderWithParse5(dom));
    /**
     * The default cheerio instance.
     *
     * @deprecated Use the function returned by `load` instead.
     */
    load([]);

    exports.Mutex = Mutex;
    exports.deleteDB = deleteDB;
    exports.load = load;
    exports.openDB = openDB;

}));
