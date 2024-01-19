const omron = require('@protocolos/node-omron-usb');

class Tools {
    constructor(){}

    getAvailablesUsb(){
        console.log("Here node")
        return omron ? omron.usbManager.getDevicesOmron() : [];
    }
}

module.exports = new Tools();