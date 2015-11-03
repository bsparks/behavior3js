'use strict';
import BaseNode from './baseNode';
import category from './category';

export default class Composite extends BaseNode {
    constructor(params = {children: []}) {
        super();

        this.category = category.COMPOSITE;
        this.children = params.children;
    }
};
