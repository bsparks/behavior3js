'use strict';
import Action from '../core/action';
import status from '../status';

export default class Succeeder extends Action {
    tick(tick) {
        return status.SUCCESS;
    }
};
