/* -*- Mode: Javascript; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {Cc, Cu, Ci} = require("chrome");

// Page size for pageup/pagedown
const PAGE_SIZE = 10;
const PREVIEW_AREA = 700;
const DEFAULT_MAX_CHILDREN = 100;

const {UndoStack} = require("devtools/shared/undo");
const promise = require("sdk/core/promise");
const {RootContainer, MarkupContainer} = require("devtools/markupview/markup-container");

Cu.import("resource:///modules/devtools/LayoutHelpers.jsm");
Cu.import("resource://gre/modules/devtools/Templater.jsm");
Cu.import("resource://gre/modules/Services.jsm");

loader.lazyGetter(this, "AutocompletePopup", () => require("devtools/shared/autocomplete-popup").AutocompletePopup);

/**
 * Vocabulary for the purposes of this file:
 *
 * MarkupContainer - the structure that holds an editor and its
 *  immediate children in the markup panel.
 * Node - A content node.
 * object.elt - A UI element in the markup panel.
 */

/**
 * The markup tree.  Manages the mapping of nodes to MarkupContainers,
 * updating based on mutations, and the undo/redo bindings.
 *
 * @param Inspector aInspector
 *        The inspector we're watching.
 * @param iframe aFrame
 *        An iframe in which the caller has kindly loaded markup-view.xhtml.
 */
function MarkupView(aInspector, aFrame, aControllerWindow)
{
  this._inspector = aInspector;
  this.walker = this._inspector.walker;
  this._frame = aFrame;
  this.doc = this._frame.contentDocument;
  this._elt = this.doc.querySelector("#root");

  try {
    this.maxChildren = Services.prefs.getIntPref("devtools.markup.pagesize");
  } catch(ex) {
    this.maxChildren = DEFAULT_MAX_CHILDREN;
  }

  // Creating the popup to be used to show CSS suggestions.
  let options = {
    fixedWidth: true,
    autoSelect: true,
    theme: "auto"
  };
  this.popup = new AutocompletePopup(this.doc.defaultView.parent.document, options);

  this.undo = new UndoStack();
  this.undo.installController(aControllerWindow);

  this._containers = new WeakMap();

  this._boundMutationObserver = this._mutationObserver.bind(this);
  this.walker.on("mutations", this._boundMutationObserver)

  this._boundOnNewSelection = this._onNewSelection.bind(this);
  this._inspector.selection.on("new-node-front", this._boundOnNewSelection);
  this._onNewSelection();

  this._boundKeyDown = this._onKeyDown.bind(this);
  this._frame.contentWindow.addEventListener("keydown", this._boundKeyDown, false);

  this._boundFocus = this._onFocus.bind(this);
  this._frame.addEventListener("focus", this._boundFocus, false);

  this._initPreview();
}

exports.MarkupView = MarkupView;

MarkupView.prototype = {
  _selectedContainer: null,

  template: function MT_template(aName, aDest, aOptions={stack: "markup-view.xhtml"})
  {
    let node = this.doc.getElementById("template-" + aName).cloneNode(true);
    node.removeAttribute("id");
    template(node, aDest, aOptions);
    return node;
  },

  /**
   * Get the MarkupContainer object for a given node, or undefined if
   * none exists.
   */
  getContainer: function MT_getContainer(aNode)
  {
    return this._containers.get(aNode);
  },

  /**
   * Highlight the inspector selected node.
   */
  _onNewSelection: function MT__onNewSelection()
  {
    let done = this._inspector.updating("markup-view");
    if (this._inspector.selection.isNode()) {
      this.showNode(this._inspector.selection.nodeFront, true).then(() => {
        this.markNodeAsSelected(this._inspector.selection.nodeFront);
        done();
      });
    } else {
      this.unmarkSelectedNode();
      done();
    }
  },

  /**
   * Create a TreeWalker to find the next/previous
   * node for selection.
   */
  _selectionWalker: function MT__seletionWalker(aStart)
  {
    let walker = this.doc.createTreeWalker(
      aStart || this._elt,
      Ci.nsIDOMNodeFilter.SHOW_ELEMENT,
      function(aElement) {
        if (aElement.container &&
            aElement.container.elt === aElement &&
            aElement.container.visible) {
          return Ci.nsIDOMNodeFilter.FILTER_ACCEPT;
        }
        return Ci.nsIDOMNodeFilter.FILTER_SKIP;
      }
    );
    walker.currentNode = this._selectedContainer.elt;
    return walker;
  },

  /**
   * Key handling.
   */
  _onKeyDown: function MT__KeyDown(aEvent)
  {
    let handled = true;

    // Ignore keystrokes that originated in editors.
    if (aEvent.target.tagName.toLowerCase() === "input" ||
        aEvent.target.tagName.toLowerCase() === "textarea") {
      return;
    }

    switch(aEvent.keyCode) {
      case Ci.nsIDOMKeyEvent.DOM_VK_H:
        let node = this._selectedContainer.node;
        if (node.hidden) {
          this.walker.unhideNode(node).then(() => this.nodeChanged(node));
        } else {
          this.walker.hideNode(node).then(() => this.nodeChanged(node));
        }
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_DELETE:
      case Ci.nsIDOMKeyEvent.DOM_VK_BACK_SPACE:
        this.deleteNode(this._selectedContainer.node);
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_HOME:
        let rootContainer = this._containers.get(this._rootNode);
        this.navigate(rootContainer.children.firstChild.container);
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_LEFT:
        if (this._selectedContainer.expanded) {
          this.collapseNode(this._selectedContainer.node);
        } else {
          let parent = this._selectionWalker().parentNode();
          if (parent) {
            this.navigate(parent.container);
          }
        }
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_RIGHT:
        if (!this._selectedContainer.expanded) {
          this._expandContainer(this._selectedContainer);
        } else {
          let next = this._selectionWalker().nextNode();
          if (next) {
            this.navigate(next.container);
          }
        }
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_UP:
        let prev = this._selectionWalker().previousNode();
        if (prev) {
          this.navigate(prev.container);
        }
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_DOWN:
        let next = this._selectionWalker().nextNode();
        if (next) {
          this.navigate(next.container);
        }
        break;
      case Ci.nsIDOMKeyEvent.DOM_VK_PAGE_UP: {
        let walker = this._selectionWalker();
        let selection = this._selectedContainer;
        for (let i = 0; i < PAGE_SIZE; i++) {
          let prev = walker.previousNode();
          if (!prev) {
            break;
          }
          selection = prev.container;
        }
        this.navigate(selection);
        break;
      }
      case Ci.nsIDOMKeyEvent.DOM_VK_PAGE_DOWN: {
        let walker = this._selectionWalker();
        let selection = this._selectedContainer;
        for (let i = 0; i < PAGE_SIZE; i++) {
          let next = walker.nextNode();
          if (!next) {
            break;
          }
          selection = next.container;
        }
        this.navigate(selection);
        break;
      }
      default:
        handled = false;
    }
    if (handled) {
      aEvent.stopPropagation();
      aEvent.preventDefault();
    }
  },

  /**
   * Delete a node from the DOM.
   * This is an undoable action.
   */
  deleteNode: function MC__deleteNode(aNode)
  {
    if (aNode.isDocumentElement ||
        aNode.nodeType == Ci.nsIDOMNode.DOCUMENT_TYPE_NODE) {
      return;
    }

    let container = this._containers.get(aNode);

    // Retain the node so we can undo this...
    this.walker.retainNode(aNode).then(() => {
      let parent = aNode.parentNode();
      let sibling = null;
      this.undo.do(() => {
        if (container.selected) {
          this.navigate(this._containers.get(parent));
        }
        this.walker.removeNode(aNode).then(nextSibling => {
          sibling = nextSibling;
        });
      }, () => {
        this.walker.insertBefore(aNode, parent, sibling);
      });
    }).then(null, console.error);
  },

  /**
   * If an editable item is focused, select its container.
   */
  _onFocus: function MC__onFocus(aEvent) {
    let parent = aEvent.target;
    while (!parent.container) {
      parent = parent.parentNode;
    }
    if (parent) {
      this.navigate(parent.container, true);
    }
  },

  /**
   * Handle a user-requested navigation to a given MarkupContainer,
   * updating the inspector's currently-selected node.
   *
   * @param MarkupContainer aContainer
   *        The container we're navigating to.
   * @param aIgnoreFocus aIgnoreFocus
   *        If falsy, keyboard focus will be moved to the container too.
   */
  navigate: function MT__navigate(aContainer, aIgnoreFocus)
  {
    if (!aContainer) {
      return;
    }

    let node = aContainer.node;
    this.markNodeAsSelected(node);
    this._inspector.selection.setNodeFront(node, "treepanel");
    // This event won't be fired if the node is the same. But the highlighter
    // need to lock the node if it wasn't.
    this._inspector.selection.emit("new-node");
    this._inspector.selection.emit("new-node-front");

    if (!aIgnoreFocus) {
      aContainer.focus();
    }
  },

  /**
   * Make sure a node is included in the markup tool.
   *
   * @param DOMNode aNode
   *        The node in the content document.
   * @returns MarkupContainer The MarkupContainer object for this element.
   */
  importNode: function MT_importNode(aNode)
  {
    if (!aNode) {
      return null;
    }

    if (this._containers.has(aNode)) {
      return this._containers.get(aNode);
    }

    if (aNode === this.walker.rootNode) {
      var container = new RootContainer(this, aNode);
      this._elt.appendChild(container.elt);
      this._rootNode = aNode;
    } else {
      var container = new MarkupContainer(this, aNode);
    }

    this._containers.set(aNode, container);
    container.childrenDirty = true;

    this._updateChildren(container);

    return container;
  },


  /**
   * Mutation observer used for included nodes.
   */
  _mutationObserver: function MT__mutationObserver(aMutations)
  {
    for (let mutation of aMutations) {
      let type = mutation.type;
      let target = mutation.target;

      if (mutation.type === "documentUnload") {
        // Treat this as a childList change of the child (maybe the protocol
        // should do this).
        type = "childList";
        target = mutation.targetParent;
        if (!target) {
          continue;
        }
      }

      let container = this._containers.get(target);
      if (!container) {
        // Container might not exist if this came from a load event for a node
        // we're not viewing.
        continue;
      }
      if (type === "attributes" || type === "characterData") {
        container.update();
      } else if (type === "childList") {
        container.childrenDirty = true;
        this._updateChildren(container);
      }
    }
    this._waitForChildren().then(() => {
      this._inspector.emit("markupmutation");
    });
  },

  /**
   * Make sure the given node's parents are expanded and the
   * node is scrolled on to screen.
   */
  showNode: function MT_showNode(aNode, centered)
  {
    let container = this.importNode(aNode);
    let parent = aNode;
    while ((parent = parent.parentNode())) {
      this.importNode(parent);
      this.expandNode(parent);
    }

    return this._waitForChildren().then(() => {
      return this._ensureVisible(aNode);
    }).then(() => {
      // Why is this not working?
      LayoutHelpers.scrollIntoViewIfNeeded(this._containers.get(aNode).editor.elt, centered);
    });
  },

  /**
   * Expand the container's children.
   */
  _expandContainer: function MT__expandContainer(aContainer)
  {
    return this._updateChildren(aContainer, true).then(() => {
      aContainer.expanded = true;
    });
  },

  /**
   * Expand the node's children.
   */
  expandNode: function MT_expandNode(aNode)
  {
    let container = this._containers.get(aNode);
    this._expandContainer(container);
  },

  /**
   * Expand the entire tree beneath a container.
   *
   * @param aContainer The container to expand.
   */
  _expandAll: function MT_expandAll(aContainer)
  {
    return this._expandContainer(aContainer).then(() => {
      let child = aContainer.children.firstChild;
      let promises = [];
      while (child) {
        promises.push(this._expandAll(child.container));
        child = child.nextSibling;
      }
      return promise.all(promises);
    }).then(null, console.error);
  },

  /**
   * Expand the entire tree beneath a node.
   *
   * @param aContainer The node to expand, or null
   *        to start from the top.
   */
  expandAll: function MT_expandAll(aNode)
  {
    aNode = aNode || this._rootNode;
    return this._expandAll(this._containers.get(aNode));
  },

  /**
   * Collapse the node's children.
   */
  collapseNode: function MT_collapseNode(aNode)
  {
    let container = this._containers.get(aNode);
    container.expanded = false;
  },

  setNodeExpanded: function(aNode, aExpanded)
  {
    if (aExpanded) {
      this.expandNode(aNode);
    } else {
      this.collapseNode(aNode);
    }
  },

  /**
   * Mark the given node selected.
   */
  markNodeAsSelected: function MT_markNodeAsSelected(aNode)
  {
    let container = this._containers.get(aNode);
    if (this._selectedContainer === container) {
      return false;
    }
    if (this._selectedContainer) {
      this._selectedContainer.selected = false;
    }
    this._selectedContainer = container;
    if (aNode) {
      this._selectedContainer.selected = true;
    }

    return true;
  },

  /**
   * Make sure that every ancestor of the selection are updated
   * and included in the list of visible children.
   */
  _ensureVisible: function(node)
  {
    while (node) {
      let container = this._containers.get(node);
      let parent = node.parentNode();
      if (!container.elt.parentNode) {
        let parentContainer = this._containers.get(parent);
        parentContainer.childrenDirty = true;
        this._updateChildren(parentContainer, node);
      }

      node = parent;
    }
    return this._waitForChildren();
  },

  /**
   * Unmark selected node (no node selected).
   */
  unmarkSelectedNode: function MT_unmarkSelectedNode()
  {
    if (this._selectedContainer) {
      this._selectedContainer.selected = false;
      this._selectedContainer = null;
    }
  },

  /**
   * Called when the markup panel initiates a change on a node.
   */
  nodeChanged: function MT_nodeChanged(aNode)
  {
    if (aNode === this._inspector.selection.nodeFront) {
      this._inspector.change("markupview");
    }
  },

  /**
   * Check if the current selection is a descendent of the container.
   * if so, make sure it's among the visible set for the container,
   * and set the dirty flag if needed.
   * @returns The node that should be made visible, if any.
   */
  _checkSelectionVisible: function(aContainer) {
    let centered = null;
    let node = this._inspector.selection.nodeFront;
    while (node) {
      if (node.parentNode() === aContainer.node) {
        centered = node;
        break;
      }
      node = node.parentNode();
    }

    return centered;
  },

  /**
   * Make sure all children of the given container's node are
   * imported and attached to the container in the right order.
   *
   * Children need to be updated only in the following circumstances:
   * a) We just imported this node and have never seen its children.
   *    container.childrenDirty will be set by importNode in this case.
   * b) We received a childList mutation on the node.
   *    container.childrenDirty will be set in that case too.
   * c) We have changed the selection, and the path to that selection
   *    wasn't loaded in a previous children request (because we only
   *    grab a subset).
   *    container.childrenDirty should be set in that case too!
   *
   * This method returns a promise that will be resolved when the children
   * are ready (which may be immediately).
   */
  _updateChildren: function(aContainer, aExpand)
  {
    aContainer.hasChildren = aContainer.node.hasChildren;

    if (!this._queuedChildUpdates) {
      this._queuedChildUpdates = new Map();
    }

    if (this._queuedChildUpdates.has(aContainer)) {
      return this._queuedChildUpdates.get(aContainer);
    }

    if (!aContainer.childrenDirty) {
      return promise.resolve(aContainer);
    }

    if (!aContainer.hasChildren) {
      while (aContainer.children.firstChild) {
        aContainer.children.removeChild(aContainer.children.firstChild);
      }
      aContainer.childrenDirty = false;
      return promise.resolve(aContainer);
    }

    // If we're not expanded (or asked to update anyway), we're done for
    // now.  Note that this will leave the childrenDirty flag set, so when
    // expanded we'll refresh the child list.
    if (!(aContainer.expanded || aExpand)) {
      return promise.resolve(aContainer);
    }

    // We're going to issue a children request, make sure it includes the
    // centered node.
    let centered = this._checkSelectionVisible(aContainer);

    // Children aren't updated yet, but clear the childrenDirty flag anyway.
    // If the dirty flag is re-set while we're fetching we'll need to fetch
    // again.
    aContainer.childrenDirty = false;
    let updatePromise = this._getVisibleChildren(aContainer, centered).then(children => {
      if (!this._containers) {
        return promise.reject("markup view destroyed");
      }
      this._queuedChildUpdates.delete(aContainer);

      // If children are dirty, we got a change notification for this node
      // while the request was in progress, we need to do it again.
      if (aContainer.childrenDirty) {
        return this._updateChildren(aContainer, centered);
      }

      let fragment = this.doc.createDocumentFragment();

      for (let child of children.nodes) {
        let container = this.importNode(child);
        fragment.appendChild(container.elt);
      }

      while (aContainer.children.firstChild) {
        aContainer.children.removeChild(aContainer.children.firstChild);
      }

      if (!(children.hasFirst && children.hasLast)) {
        let data = {
          showing: this.strings.GetStringFromName("markupView.more.showing"),
          showAll: this.strings.formatStringFromName(
                    "markupView.more.showAll",
                    [aContainer.node.numChildren.toString()], 1),
          allButtonClick: () => {
            aContainer.maxChildren = -1;
            aContainer.childrenDirty = true;
            this._updateChildren(aContainer);
          }
        };

        if (!children.hasFirst) {
          let span = this.template("more-nodes", data);
          fragment.insertBefore(span, fragment.firstChild);
        }
        if (!children.hasLast) {
          let span = this.template("more-nodes", data);
          fragment.appendChild(span);
        }
      }

      aContainer.children.appendChild(fragment);
      return aContainer;
    }).then(null, console.error);
    this._queuedChildUpdates.set(aContainer, updatePromise);
    return updatePromise;
  },

  _waitForChildren: function() {
    if (!this._queuedChildUpdates) {
      return promise.resolve(undefined);
    }
    return promise.all([updatePromise for (updatePromise of this._queuedChildUpdates.values())]);
  },

  /**
   * Return a list of the children to display for this container.
   */
  _getVisibleChildren: function MV__getVisibleChildren(aContainer, aCentered)
  {
    let maxChildren = aContainer.maxChildren || this.maxChildren;
    if (maxChildren == -1) {
      maxChildren = undefined;
    }

    return this.walker.children(aContainer.node, {
      maxNodes: maxChildren,
      center: aCentered
    });
  },

  /**
   * Tear down the markup panel.
   */
  destroy: function MT_destroy()
  {
    this.undo.destroy();
    delete this.undo;

    this.popup.destroy();
    delete this.popup;

    this._frame.removeEventListener("focus", this._boundFocus, false);
    delete this._boundFocus;

    if (this._boundUpdatePreview) {
      this._frame.contentWindow.removeEventListener("scroll", this._boundUpdatePreview, true);
      delete this._boundUpdatePreview;
    }

    if (this._boundResizePreview) {
      this._frame.contentWindow.removeEventListener("resize", this._boundResizePreview, true);
      this._frame.contentWindow.removeEventListener("overflow", this._boundResizePreview, true);
      this._frame.contentWindow.removeEventListener("underflow", this._boundResizePreview, true);
      delete this._boundResizePreview;
    }

    this._frame.contentWindow.removeEventListener("keydown", this._boundKeyDown, false);
    delete this._boundKeyDown;

    this._inspector.selection.off("new-node-front", this._boundOnNewSelection);
    delete this._boundOnNewSelection;

    this.walker.off("mutations", this._boundMutationObserver)
    delete this._boundMutationObserver;

    delete this._elt;

    delete this._containers;
  },

  /**
   * Initialize the preview panel.
   */
  _initPreview: function MT_initPreview()
  {
    if (!Services.prefs.getBoolPref("devtools.inspector.markupPreview")) {
      return;
    }

    this._previewBar = this.doc.querySelector("#previewbar");
    this._preview = this.doc.querySelector("#preview");
    this._viewbox = this.doc.querySelector("#viewbox");

    this._previewBar.classList.remove("disabled");

    this._previewWidth = this._preview.getBoundingClientRect().width;

    this._boundResizePreview = this._resizePreview.bind(this);
    this._frame.contentWindow.addEventListener("resize", this._boundResizePreview, true);
    this._frame.contentWindow.addEventListener("overflow", this._boundResizePreview, true);
    this._frame.contentWindow.addEventListener("underflow", this._boundResizePreview, true);

    this._boundUpdatePreview = this._updatePreview.bind(this);
    this._frame.contentWindow.addEventListener("scroll", this._boundUpdatePreview, true);
    this._updatePreview();
  },


  /**
   * Move the preview viewbox.
   */
  _updatePreview: function MT_updatePreview()
  {
    let win = this._frame.contentWindow;

    if (win.scrollMaxY == 0) {
      this._previewBar.classList.add("disabled");
      return;
    }

    this._previewBar.classList.remove("disabled");

    let ratio = this._previewWidth / PREVIEW_AREA;
    let width = ratio * win.innerWidth;

    let height = ratio * (win.scrollMaxY + win.innerHeight);
    let scrollTo
    if (height >= win.innerHeight) {
      scrollTo = -(height - win.innerHeight) * (win.scrollY / win.scrollMaxY);
      this._previewBar.setAttribute("style", "height:" + height + "px;transform:translateY(" + scrollTo + "px)");
    } else {
      this._previewBar.setAttribute("style", "height:100%");
    }

    let bgSize = ~~width + "px " + ~~height + "px";
    this._preview.setAttribute("style", "background-size:" + bgSize);

    let height = ~~(win.innerHeight * ratio) + "px";
    let top = ~~(win.scrollY * ratio) + "px";
    this._viewbox.setAttribute("style", "height:" + height + ";transform: translateY(" + top + ")");
  },

  /**
   * Hide the preview while resizing, to avoid slowness.
   */
  _resizePreview: function MT_resizePreview()
  {
    let win = this._frame.contentWindow;
    this._previewBar.classList.add("hide");
    win.clearTimeout(this._resizePreviewTimeout);

    win.setTimeout(function() {
      this._updatePreview();
      this._previewBar.classList.remove("hide");
    }.bind(this), 1000);
  }
};

loader.lazyGetter(MarkupView.prototype, "strings", () => Services.strings.createBundle(
  "chrome://browser/locale/devtools/inspector.properties"
));
