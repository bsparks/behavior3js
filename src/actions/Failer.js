'use strict';
import Action from '../core/action';
import status from '../core/status';

export default class Failer extends Action {
    tick(tick) {
        return status.FAILURE;
    }
};
