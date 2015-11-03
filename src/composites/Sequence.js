'use strict';
import status from '../core/status';
import Composite from '../core/composite';

export default class Sequence extends Composite {
    tick(tick) {
        for(let child of this.children) {
            let childStatus = child._execute(tick);
            if (childStatus !== status.SUCCESS) {
                return childStatus;
            }
        }

        return status.SUCCESS;
    }
};
