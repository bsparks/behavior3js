'use strict';
import BaseNode from './baseNode';
import category from '../category';

export default class Action extends BaseNode {
    constructor() {
        super();

        this.category = category.ACTION;
    }
};
