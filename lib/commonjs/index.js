"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BleNitro = exports.AndroidScanMode = exports.BLEState = void 0;
const manager_1 = require("./manager");
var manager_2 = require("./manager");
Object.defineProperty(exports, "BLEState", { enumerable: true, get: function () { return manager_2.BLEState; } });
Object.defineProperty(exports, "AndroidScanMode", { enumerable: true, get: function () { return manager_2.AndroidScanMode; } });
let _instance;
class BleNitro extends manager_1.BleNitroManager {
    static instance() {
        if (!_instance) {
            _instance = new BleNitro();
        }
        return _instance;
    }
}
exports.BleNitro = BleNitro;
//# sourceMappingURL=index.js.map