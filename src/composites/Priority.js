'use strict';
import status from '../status';
import Composite from '../core/composite';

export default class Priority extends Composite {
    tick(tick) {
        for(let child of this.children) {
            let childStatus = child._execute(tick);
            if (childStatus !== status.FAILURE) {
                return childStatus;
            }
        }

        return status.FAILURE;
    }
};
