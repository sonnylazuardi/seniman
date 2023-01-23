import fs from 'node:fs';
import process from 'node:process';
import { FastRateLimit } from 'fast-ratelimit';
import { Window } from './window.js';

// get ram limit from env var
let RSS_LOW_MEMORY_THRESHOLD = process.env.RSS_LOW_MEMORY_THRESHOLD ? parseInt(process.env.RSS_LOW_MEMORY_THRESHOLD) : 180;

class ExternalPromise {
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve
            this.reject = reject
        })
    }

    then(resolve, reject) {
        return this.promise.then(resolve, reject)
    }

    catch(reject) {
        return this.promise.catch(reject)
    }
}

class WindowManager {

    constructor() {
        this.windowMap = new Map();

        this._runWindowsLifecycleManagement();

        this.queue = [];
        this.emptyQueuePromise = new ExternalPromise();

        // TODO: we'll want to make this configurable & broadcast
        // this to the client so that they can adjust their message
        // sending rate accordingly -- i.e. we'll catch mostly the bad actors
        // here and not good actors sending too many messages in some chatty part
        // of the app
        this.messageLimiter = new FastRateLimit({
            threshold: 8,
            ttl: 2
        });

        this._processMessages();
    }

    async _processMessages() {
        let message, window;
        let PONG_COMMAND = 0;

        while ([window, message] = await this._dequeueMessage()) {
            let buffer = Buffer.from(message);

            if (buffer.readUint8(0) == PONG_COMMAND) {
                window.lastPongTime = Date.now();
                window.connected = true;

                let readOffset = buffer.readUInt32LE(1);
                window.registerReadOffset(readOffset);
            } else {
                window.onMessage(buffer);
            }
        }
    }

    _dequeueMessage() {

        return new Promise(async (resolve) => {

            if (this.queue.length == 0) {
                await this.emptyQueuePromise;
            }

            resolve(this.queue.shift());
        });
    }

    _enqueueMessage(window, message) {

        // TODO:
        // check rate of windowId messages in the last sliding window
        // 3 possible outputs:
        // LOW, HIGH, EXCEEDS_LIMIT

        let wasEmptyQueue = this.queue.length == 0;
        let isUnderLimit = this.messageLimiter.consumeSync(window.id);

        // if EXCEEDS_LIMIT, we'll drop the message rather than enqueue it
        // for other cases, we'll enqueue the message
        if (!isUnderLimit) {
            // TODO: we probably want to also close the window's connection or even destroy the window
            return;
        }

        /*

        TODO:
        
        In here, we'll do stuff differently based on if the window has HIGH or LOW message rates.
        We want to prioritize windows with LOW message rates, so we'll do the following:
        - If the window has LOW message rates, we'll enqueue the message in the primary queue
        - If the window has HIGH message rates, we'll enqueue the message in the secondary queue

        The secondary queue will be processed after the primary queue is empty. If too much time has 
        elapsed since the last time the secondary queue was processed, we'll start processing the secondary
        until we see a message with a recent enough timestamp -- and we'll start switching back to the primary
        queue.

        A window is always either in the primary or secondary queue. We won't promote back a window
        to the primary queue if its message rate has not dropped to LOW.

        */

        this.queue.push([window, message]);

        if (wasEmptyQueue) {
            this.emptyQueuePromise.resolve();
            this.emptyQueuePromise = new ExternalPromise();
        }
    }

    _runWindowsLifecycleManagement() {

        this.pingInterval = setInterval(() => {
            let now = Date.now();

            // get RSS memory usage
            let rss = process.memoryUsage().rss / 1024 / 1024;

            let isLowMemory = rss > RSS_LOW_MEMORY_THRESHOLD;

            if (isLowMemory) {
                console.log('Low memory detected, RSS:', rss);
            }

            for (let window of this.windowMap.values()) {
                let pongDiff = now - window.lastPongTime;

                if (pongDiff >= 6000) {
                    window.connected = false;
                }

                if (!window.connected) {
                    let destroyTimeout = 60000;

                    if (isLowMemory || pongDiff >= destroyTimeout) {
                        window.destroy();
                        continue;
                    }
                }

                window.sendPing();
                window.flushBlockDeleteQueue();
            }
        }, 2500);
    }

    async initWindow(windowId, initialPath, cookieString, port2) {

        // TODO: pass request's ip address here, and rate limit window creation based on ip address
        let build = await loadBuild();
        let window = new Window(windowId, initialPath, cookieString, build, port2);

        this.windowMap.set(windowId, window);

        port2.on('message', async (message) => {
            this._enqueueMessage(window, message);
        });

        window.onDestroy(() => {
            this.windowMap.delete(windowId);

            if (this.windowDestroyCallback) {
                this.windowDestroyCallback(windowId);
            }
        });
    }

    onWindowDestroy(callback) {
        this.windowDestroyCallback = callback;
    }

    reconnectWindow(msg) {
        let { windowId, cookieString, readOffset } = msg;

        this.windowMap.get(windowId).reconnect(cookieString, readOffset);
    }

    disconnectWindow(windowId) {
        if (this.windowMap.has(windowId)) {
            this.windowMap.get(windowId).disconnect();
        }
    }

    loadBuild(path) {
        loadBuild(path);
    }
}


export const windowManager = new WindowManager();

let cachedBuild = null;
let buildLoadStartedPromise = null;

export const loadBuild = async (buildPath) => {

    if (buildLoadStartedPromise) {

        if (cachedBuild) {
            return cachedBuild;
        }

        return buildLoadStartedPromise;
    } else {

        buildLoadStartedPromise = new Promise(async (resolve, reject) => {

            // track function time
            let startTime = performance.now();

            let [PlatformModule, IndexModule, compressionCommandBuffer, reverseIndexMap, globalCssBuffer] = await Promise.all([
                import(buildPath + '/_platform.js'),

                // TODO: set rootComponent path from config value instead of hardcoding
                import(buildPath + '/index.js'),
                fs.promises.readFile(buildPath + '/compression-command.bin'),
                fs.promises.readFile(buildPath + '/reverse-index-map.json'),
                fs.promises.readFile(buildPath + '/global.css')
            ]);

            let build = {
                PlatformModule,
                IndexModule,
                reverseIndexMap: JSON.parse(reverseIndexMap),
                compressionCommandBuffer: compressionCommandBuffer,
                globalCss: globalCssBuffer.toString()
            };

            try {
                build.syntaxErrors = JSON.parse(await fs.promises.readFile(buildPath + '/SyntaxErrors.json'));
            } catch (e) {
                console.log('No syntax errors.');
                //build.rootComponent = (await import(buildPath + '/RootComponent.js')).default;
            }

            console.log('load time:', performance.now() - startTime);
            console.log('build loaded.');
            cachedBuild = build;
            resolve(build);
        });

        return buildLoadStartedPromise;
    }
}
