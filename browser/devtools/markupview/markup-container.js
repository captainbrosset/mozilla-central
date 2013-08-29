/* -*- Mode: Javascript; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {Cc, Cu, Ci} = require("chrome");
const {GenericEditor,
       DoctypeEditor,
       TextEditor,
       ElementEditor} = require("devtools/markupview/editors");

/**
 * Dummy container node used for the root document element.
 */
function RootContainer(aMarkupView, aNode) {
  this.doc = aMarkupView.doc;
  this.elt = this.doc.createElement("ul");
  this.elt.container = this;
  this.children = this.elt;
  this.node = aNode;
  this.toString = function() { return "[root container]"}
}

exports.RootContainer = RootContainer;

RootContainer.prototype = {
  hasChildren: true,
  expanded: true,
  update: function() {}
};

/**
 * The main structure for storing a document node in the markup
 * tree.  Manages creation of the editor for the node and
 * a <ul> for placing child elements, and expansion/collapsing
 * of the element.
 * 
 * @param MarkupView aMarkupView
 *        The markup view that owns this container.
 * @param DOMNode aNode
 *        The node to display.
 */
function MarkupContainer(aMarkupView, aNode) {
  this.markup = aMarkupView;
  this.doc = this.markup.doc;
  this.undo = this.markup.undo;
  this.node = aNode;

  if (aNode.nodeType == Ci.nsIDOMNode.TEXT_NODE) {
    this.editor = new TextEditor(this, aNode, "text");
  } else if (aNode.nodeType == Ci.nsIDOMNode.COMMENT_NODE) {
    this.editor = new TextEditor(this, aNode, "comment");
  } else if (aNode.nodeType == Ci.nsIDOMNode.ELEMENT_NODE) {
    this.editor = new ElementEditor(this, aNode);
  } else if (aNode.nodeType == Ci.nsIDOMNode.DOCUMENT_TYPE_NODE) {
    this.editor = new DoctypeEditor(this, aNode);
  } else {
    this.editor = new GenericEditor(this, aNode);
  }

  // The template will fill the following properties
  this.elt = null;
  this.expander = null;
  this.highlighter = null;
  this.tagLine = null;
  this.children = null;
  this.markup.template("container", this);
  this.elt.container = this;
  this.children.container = this;

  // Expanding/collapsing the node on dblclick of the whole tag-line element
  this._onToggle = this._onToggle.bind(this);
  this.elt.addEventListener("dblclick", this._onToggle, false);
  this.expander.addEventListener("click", this._onToggle, false);

  // Dealing with the highlighting of the row via javascript rather than :hover
  // This is to allow highlighting the closing tag-line as well as reusing the
  // theme css classes (which wouldn't have been possible with a :hover pseudo)
  this._onMouseOver = this._onMouseOver.bind(this);
  this.elt.addEventListener("mouseover", this._onMouseOver, false);

  this._onMouseOut = this._onMouseOut.bind(this);
  this.elt.addEventListener("mouseout", this._onMouseOut, false);

  // Appending the editor element and attaching event listeners
  this.tagLine.appendChild(this.editor.elt);

  this.elt.addEventListener("mousedown", this._onMouseDown.bind(this), false);
}

exports.MarkupContainer = MarkupContainer;

MarkupContainer.prototype = {
  toString: function() {
    return "[MarkupContainer for " + this.node + "]";
  },

  /**
   * True if the current node has children.  The MarkupView
   * will set this attribute for the MarkupContainer.
   */
  _hasChildren: false,

  get hasChildren() {
    return this._hasChildren;
  },

  set hasChildren(aValue) {
    this._hasChildren = aValue;
    if (aValue) {
      this.expander.style.visibility = "visible";
    } else {
      this.expander.style.visibility = "hidden";
    }
  },

  parentContainer: function() {
    return this.elt.parentNode ? this.elt.parentNode.container : null;
  },

  /**
   * True if the node has been visually expanded in the tree.
   */
  get expanded() {
    return !this.elt.classList.contains("collapsed");
  },

  set expanded(aValue) {
    if (aValue && this.elt.classList.contains("collapsed")) {
      // Expanding a node means cloning its "inline" closing tag into a new
      // tag-line that the user can interact with and showing the children.
      if (this.editor instanceof ElementEditor) {
        let closingTag = this.elt.querySelector(".close");
        if (closingTag) {
          if (!this.closeTagLine) {
            let line = this.markup.doc.createElement("div");
            line.classList.add("tag-line");

            let highlighter = this.markup.doc.createElement("div");
            highlighter.classList.add("highlighter");
            line.appendChild(highlighter);

            line.appendChild(closingTag.cloneNode(true));
            line.addEventListener("mouseover", this._onMouseOver, false);
            line.addEventListener("mouseout", this._onMouseOut, false);

            this.closeTagLine = line;
          }
          this.elt.appendChild(this.closeTagLine);
        }
      }
      this.elt.classList.remove("collapsed");
      this.expander.setAttribute("open", "");
      this.highlighted = false;
    } else if (!aValue) {
      if (this.editor instanceof ElementEditor && this.closeTagLine) {
        this.elt.removeChild(this.closeTagLine);
      }
      this.elt.classList.add("collapsed");
      this.expander.removeAttribute("open");
    }
  },

  _onToggle: function(event) {
    this.markup.navigate(this);
    if(this.hasChildren) {
      this.markup.setNodeExpanded(this.node, !this.expanded);
    }
    event.stopPropagation();
  },

  _onMouseOver: function(event) {
    this.highlighted = true;
    event.stopPropagation();
  },

  _onMouseOut: function(event) {
    this.highlighted = false;
    event.stopPropagation();
  },

  _onMouseDown: function(event) {
    this.highlighted = false;
    this.markup.navigate(this);
    event.stopPropagation();
  },

  _highlighted: false,

  /**
   * Highlight the currently hovered tag + its closing tag if necessary
   * (that is if the tag is expanded)
   */
  set highlighted(aValue) {
    this._highlighted = aValue;
    if (aValue) {
      if (!this.selected) {
        this.highlighter.classList.add("theme-bg-darker");
      }
      if (this.closeTagLine) {
        this.closeTagLine.querySelector(".highlighter").classList.add("theme-bg-darker");
      }
    } else {
      this.highlighter.classList.remove("theme-bg-darker");
      if (this.closeTagLine) {
        this.closeTagLine.querySelector(".highlighter").classList.remove("theme-bg-darker");
      }
    }
  },

  /**
   * True if the container is visible in the markup tree.
   */
  get visible() {
    return this.elt.getBoundingClientRect().height > 0;
  },

  /**
   * True if the container is currently selected.
   */
  _selected: false,

  get selected() {
    return this._selected;
  },

  set selected(aValue) {
    this._selected = aValue;
    this.editor.selected = aValue;
    if (this._selected) {
      this.tagLine.setAttribute("selected", "");
      this.highlighter.classList.add("theme-selected");
    } else {
      this.tagLine.removeAttribute("selected");
      this.highlighter.classList.remove("theme-selected");
    }
  },

  /**
   * Update the container's editor to the current state of the
   * viewed node.
   */
  update: function() {
    if (this.editor.update) {
      this.editor.update();
    }
  },

  /**
   * Try to put keyboard focus on the current editor.
   */
  focus: function() {
    let focusable = this.editor.elt.querySelector("[tabindex]");
    if (focusable) {
      focusable.focus();
    }
  }
};
