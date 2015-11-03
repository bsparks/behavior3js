'use strict';
import Action from '../core/action';
import status from '../status';

export default class Error extends Action {
    tick(tick) {
        return status.ERROR;
    }
};
