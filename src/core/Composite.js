'use strict';
import BaseNode from './baseNode';
import category from './category';

export default class Composite extends BaseNode {
    constructor(children = []) {
        super();

        this.category = category.COMPOSITE;
        this.children = children;
    }
};
