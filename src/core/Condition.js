'use strict';
import BaseNode from './baseNode';
import category from '../category';

export default class Condition extends BaseNode {
    constructor() {
        super();

        this.category = category.CONDITION;
    }
};
