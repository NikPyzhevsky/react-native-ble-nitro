import { BleNitroManager } from "./manager";
export { BLEState, AndroidScanMode, } from "./manager";
let _instance;
export class BleNitro extends BleNitroManager {
    static instance() {
        if (!_instance) {
            _instance = new BleNitro();
        }
        return _instance;
    }
}
