const omron = require('@protocolos/node-omron-usb');

class Tools {
    constructor(){}

    getAvailablesUsb(){
        return omron ? omron.usbManager.getDevicesOmron() : [];
    }
}

module.exports = new Tools();