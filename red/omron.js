//@ts-check
try {
    var Omron = require("@protocolos/node-omron-usb");
} catch (error) {
    var Omron = null;
}
const tools = require('../src/tools')

const MIN_CYCLE_TIME = 100;

module.exports = function (RED) {

    RED.httpAdmin.get('/__node-red-contrib-omron-usb/available-usb', RED.auth.needsPermission('omron.discover'), function (req, res) {
        try {
            const adapters = tools.getAvailablesUsb();
            res.json(adapters).end();
        } catch (e) {
            res.status(500).json(e && e.toString()).end();
        }
    });

    function generateStatus(status, val) {
        let obj;
        if (typeof val != "string" && typeof val != "number" && typeof val != "boolean") {
            val = RED._("omron.endpoint.status.online");
        }
        switch (status) {
            case "online":
                obj = {
                    fill: "green",
                    shape: "dot",
                    text: val.toString(),
                };
                break;
            case "offline":
                obj = {
                    fill: "red",
                    shape: "dot",
                    text: RED._("omron.endpoint.status.offline"),
                };
                break;
            case "connecting":
                obj = {
                    fill: "yellow",
                    shape: "dot",
                    text: RED._("omron.endpoint.status.connecting"),
                };
                break;
            default:
                obj = {
                    fill: "grey",
                    shape: "dot",
                    text: RED._("omron.endpoint.status.unknown"),
                };
        }
        return obj;
    }

    function createTranslationTable(vars) {
        let res = {};

        vars.forEach(function (elm) {
            if (!elm.name || !elm.addr) {
                //skip incomplete entries
                return;
            }

            res[elm.name] = elm.addr;
        });

        return res;
    }

    function equals(a, b) {
        if (a === b) return true;
        if (a == null || b == null) return false;
        if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length != b.length) return false;

            for (let i = 0; i < a.length; ++i) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }
        return false;
    }

    function nrInputShim(node, fn) {
        node.on("input", function (msg, send, done) {
            send = send || node.send;
            done = done || ((err) => err && node.error(err, msg));
            fn(msg, send, done);
        });
    }

    // <Begin> --- Endpoint ---
    function OmronEndpoint(config) {
        let oldValues = {};
        let readInProgress = false;
        let readDeferred = 0;
        let currentCycleTime = config.cycletime;
        let timeout = config.timeout;
        let _cycleInterval;
        let _reconnectTimeout = null;
        let connected = false;
        let status;
        let that = this;
        let addressGroup = null;
        that.endpointOmron = null

        RED.nodes.createNode(this, config);

        //avoids warnings when we have a lot of omron In nodes
        this.setMaxListeners(0);

        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            that.emit("__STATUS__", status);
        }

        function doCycle() {
            if (!readInProgress && connected) {
                readInProgress = true;

                addressGroup
                    .readAllItems()
                    .then((result) => {
                        cycleCallback(result);
                    })
                    .catch((error) => {
                        onError(error);
                        readInProgress = false;
                    });
            } else {
                readDeferred++;
            }
        }

        function cycleCallback(values) {
            readInProgress = false;

            if (readDeferred && connected) {
                doCycle();
                readDeferred = 0;
            }

            manageStatus("online");

            var changed = false;
            that.emit("__ALL__", values);
            Object.keys(values).forEach(function (key) {
                if (!equals(oldValues[key], values[key])) {
                    changed = true;
                    that.emit(key, values[key]);
                    that.emit("__CHANGED__", {
                        key: key,
                        value: values[key],
                    });
                    oldValues[key] = values[key];
                }
            });
            if (changed) that.emit("__ALL_CHANGED__", values);
        }

        function updateCycleTime(interval) {
            let time = parseInt(interval);

            if (isNaN(time) || time < 0) {
                that.error(RED._("omron.endpoint.error.invalidtimeinterval", { interval: interval }));
                return false;
            }

            clearInterval(_cycleInterval);

            // don't set a new timer if value is zero
            if (!time) return false;

            if (time < MIN_CYCLE_TIME) {
                that.warn(RED._("omron.endpoint.info.cycletimetooshort", { min: MIN_CYCLE_TIME }));
                time = MIN_CYCLE_TIME;
            }

            currentCycleTime = time;
            _cycleInterval = setInterval(doCycle, time);

            return true;
        }

        function removeListeners() {
            if (that.endpointOmron !== null) {
                that.endpointOmron.removeListener("connected", onConnect);
                that.endpointOmron.removeListener("disconnected", onDisconnect);
                that.endpointOmron.removeListener("error", onError);
                that.endpointOmron.removeListener("timeout", onTimeout);
            }
        }

        /**
         * Destroys the omron connection
         * @param {Boolean} [reconnect=true]
         * @returns {Promise}
         */
        async function disconnect(reconnect = true) {
            connected = false;

            clearInterval(_cycleInterval);
            _cycleInterval = null;
            
            if (that.endpointOmron) {
                if (!reconnect) that.endpointOmron.removeListener("disconnected", onDisconnect);
                that.endpointOmron.destroy().then().catch(err => onError(err))
                that.endpointOmron = null;
            }

            console.log("Endpoint - disconnect");
        }

        async function connect() {
            if (!Omron) return that.error('Missing "@protocols/node-omron-usb" dependency, avaliable only on the ST-One hardware. Please contact us at "st-one.io" for pricing and more information.');

            manageStatus("connecting");

            if (_reconnectTimeout !== null) {
                clearTimeout(_reconnectTimeout);
                _reconnectTimeout = null;
            }

            if (that.omronEndpoint !== null) {
                await disconnect();
            }

            that.endpointOmron = new Omron.OmronEndpoint({timeout: timeout,dev: config.usb});

            that.endpointOmron.on("connected", onConnect);
            that.endpointOmron.on("disconnected", () => onDisconnect);
            that.endpointOmron.on("error", onError);
            that.endpointOmron.on("timeout", onTimeout);

            that.endpointOmron.connect();
        }

        function onConnect() {
            readInProgress = false;
            readDeferred = 0;
            connected = true;

            addressGroup = new Omron.OmronItemGroup(that.endpointOmron);

            manageStatus("online");

            let _vars = createTranslationTable(config.vartable);

            addressGroup.setTranslationCB((k) => _vars[k]);
            let varKeys = Object.keys(_vars);

            if (!varKeys || !varKeys.length) {
                that.warn(RED._("omron.endpoint.info.novars"));
            } else {
                addressGroup.addItems(varKeys);
                updateCycleTime(currentCycleTime);
            }
        }

        function onDisconnect() {
            manageStatus("offline");
            if (!_reconnectTimeout) {
                _reconnectTimeout = setTimeout(connect, 4000);
            }
            removeListeners();
        }

        function onError(e) {
            manageStatus("offline");
            that.error(e && e.toString());
            disconnect();
        }

        function onTimeout(e) {
            manageStatus("offline");
            that.error(e && e.toString());
            disconnect();
        }

        function getStatus() {
            that.emit("__STATUS__", status);
        }

        function updateCycleEvent(obj) {
            obj.err = updateCycleTime(obj.msg.payload);
            that.emit("__UPDATE_CYCLE_RES__", obj);
        }

        manageStatus("offline");

        this.on("__DO_CYCLE__", doCycle);
        this.on("__UPDATE_CYCLE__", updateCycleEvent);
        this.on("__GET_STATUS__", getStatus);

        connect();

        this.on("close", (done) => {
            manageStatus("offline");
            clearInterval(_cycleInterval);
            clearTimeout(_reconnectTimeout);
            _cycleInterval = null;
            _reconnectTimeout = null;

            that.removeListener("__DO_CYCLE__", doCycle);
            that.removeListener("__UPDATE_CYCLE__", updateCycleEvent);
            that.removeListener("__GET_STATUS__", getStatus);

            that.endpointOmron.destroy()
                .then(() => done())
                .catch(err => onError(err))

            console.log("Endpoint - on close!");
        });
    }

    RED.nodes.registerType("omron endpoint", OmronEndpoint);
    // <End> --- Endpoint ---


    // <Begin> --- Omron In
    function OmronIn(config) {
        RED.nodes.createNode(this, config);
        let statusVal;
        let that = this

        let endpoint = RED.nodes.getNode(config.endpoint);

        if (!endpoint) {
            that.error(RED._("omron.error.missingconfig"));
            return;
        }

        function sendMsg(data, key, status) {
            if (key === undefined) key = '';
            if (data instanceof Date) data = data.getTime();
            var msg = {
                payload: data,
                topic: key
            };
            statusVal = status !== undefined ? status : data;
            that.send(msg);
            endpoint.emit('__GET_STATUS__');
        }
        
        function onChanged(variable) {
            sendMsg(variable.value, variable.key, null);
        }

        function onDataSplit(data) {
            Object.keys(data).forEach(function (key) {
                sendMsg(data[key], key, null);
            });
        }

        function onData(data) {
            sendMsg(data, config.mode == 'single' ? config.variable : '');
        }

        function onDataSelect(data) {
            onData(data[config.variable]);
        }

        function onEndpointStatus(status) {
            that.status(generateStatus(status, statusVal));
        }
        
        endpoint.on('__STATUS__', onEndpointStatus);
        endpoint.emit('__GET_STATUS__');

        if (config.diff) {
            switch (config.mode) {
                case 'all-split':
                    endpoint.on('__CHANGED__', onChanged);
                    break;
                case 'single':
                    endpoint.on(config.variable, onData);
                    break;
                case 'all':
                default:
                    endpoint.on('__ALL_CHANGED__', onData);
            }
        } else {
            switch (config.mode) {
                case 'all-split':
                    endpoint.on('__ALL__', onDataSplit);
                    break;
                case 'single':
                    endpoint.on('__ALL__', onDataSelect);
                    break;
                case 'all':
                default:
                    endpoint.on('__ALL__', onData);
            }
        }

        this.on('close', function (done) {
            endpoint.removeListener('__ALL__', onDataSelect);
            endpoint.removeListener('__ALL__', onDataSplit);
            endpoint.removeListener('__ALL__', onData);
            endpoint.removeListener('__ALL_CHANGED__', onData);
            endpoint.removeListener('__CHANGED__', onChanged);
            endpoint.removeListener('__STATUS__', onEndpointStatus);
            endpoint.removeListener(config.variable, onData);
            done();
        });

    }

    RED.nodes.registerType('omron in', OmronIn);
    // <End> --- Omron In

    // <Begin> --- Omron Control
    function OmronControl(config) {
        let that = this;
        RED.nodes.createNode(this, config);

        let endpoint = RED.nodes.getNode(config.endpoint);

        if (!endpoint) {
            this.error(RED._("omron.error.missingconfig"));
            return;
        }

        function onEndpointStatus(status) {
            that.status(generateStatus(status));
        }

        function onMessage(msg, send, done) {
            let func = config.function || msg.function;
            switch (func) {
                case 'cycletime':
                    endpoint.emit('__UPDATE_CYCLE__', {
                        msg: msg,
                        send: send,
                        done: done
                    });
                    break;
                case 'trigger':
                    endpoint.emit('__DO_CYCLE__');
                    send(msg);
                    done();
                    break;

                default:
                    this.error(RED._("omron.error.invalidcontrolfunction", { function: config.function }), msg);
            }
        }

        function onUpdateCycle(res) {
            let err = res.err;
            if (!err) {
                res.done(err);
            } else {
                res.send(res.msg);
                res.done();
            }
        }

        endpoint.on('__STATUS__', onEndpointStatus);
        endpoint.on('__UPDATE_CYCLE_RES__', onUpdateCycle);

        endpoint.emit('__GET_STATUS__');

        nrInputShim(this, onMessage);

        this.on('close', function (done) {
            endpoint.removeListener('__STATUS__', onEndpointStatus);
            endpoint.removeListener('__UPDATE_CYCLE_RES__', onUpdateCycle);
            done();
        });

    }
    RED.nodes.registerType("omron control", OmronControl);
    // <End> --- Omron Control
};
