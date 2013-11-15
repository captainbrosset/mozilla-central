/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {Cu, Cc, Ci} = require("chrome");
const protocol = require("devtools/server/protocol");
const {Arg, Option, method, RetVal, types} = protocol;
const events = require("sdk/event/core");
// Make sure the domnode type is known here
require("devtools/server/actors/inspector");

Cu.import("resource://gre/modules/devtools/LayoutHelpers.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// FIXME: add ":visited" and ":link" after bug 713106 is fixed
const PSEUDO_CLASSES = [":hover", ":active", ":focus"];
const HIGHLIGHTED_PSEUDO_CLASS = ":-moz-devtools-highlighted";
let HELPER_SHEET = ".__fx-devtools-hide-shortcut__ { visibility: hidden !important } ";
HELPER_SHEET += ":-moz-devtools-highlighted { outline: 2px dashed #F06!important; outline-offset: -2px!important } ";

/**
 * The HighlighterActor is the server-side entry points for any tool that wishes
 * to highlight elements in the content document.
 *
 * All you need to start highlighting is a HighlighterFront and a reference to
 * a NodeActor. Once you have that, you may start sending requests to highlight
 * the box model of the element represented by the NodeActor for instance.
 */

exports.register = function(handle) {
  handle.addTabActor(HighlighterActor, "highlighterActor");
};

exports.unregister = function(handle) {
  handle.removeTabActor(HighlighterActor);
};

/**
 * The HighlighterActor class
 */
let HighlighterActor = protocol.ActorClass({
  typeName: "highlighter",

  initialize: function(conn, tabActor) {
    protocol.Actor.prototype.initialize.call(this, conn);
    this.tabActor = tabActor;
    this._browser = this.tabActor.browser;

    this._isHoverModeOn = false;
    this._isTouch = "ontouchstart" in this._browser.contentWindow;

    this._layoutHelpers = new LayoutHelpers(this._browser.contentWindow);

    // See if we can create the BoxModelHighlighter, that means we can reach the
    // browser parentNode to attach the new XUL markup.
    // If that fails, revert to the simpler outline highlighter
    try {
      this._boxModelHighlighter = new BoxModelHighlighter(this._browser);
    } catch (e) {
      this._boxModelHighlighter = new SimpleOutlineHighlighter(this._browser);
    }
  },

  destroy: function() {
    this._boxModelHighlighter.destroy();
    this._browser = null;

    protocol.Actor.prototype.destroy.call(this);
  },

  get window() this.tabActor.window,

  /**
   * Display the box model highlighting on a given NodeActor.
   * There is only one instance of the box model highlighter, so calling this
   * method several times won't display several highlighters, it will just move
   * the highlighter instance to these nodes.
   */
  showBoxModel: method(function(node) {
    if (this._isNodeValidForHighlighting(node.rawNode)) {
      this._boxModelHighlighter.show(node.rawNode);
    } else {
      this._boxModelHighlighter.hide();
    }
  }, {
    request: {
      node: Arg(0, "domnode")
    }
  }),

  _isNodeValidForHighlighting: function(node) {
    // Is it null or dead?
    let isNotDead = node && !Cu.isDeadWrapper(node);

    // Is it connected to the document?
    let isConnected = false;
    try {
      let doc = node.ownerDocument;
      isConnected = (doc && doc.defaultView && doc.documentElement.contains(node));
    } catch (e) {
      // "can't access dead object" error
    }

    // Is it an element node
    let isElementNode = node.nodeType === Ci.nsIDOMNode.ELEMENT_NODE;

    return isNotDead && isConnected && isElementNode;
  },

  /**
   * Hide the box model highlighting if it was shown before
   */
  hideBoxModel: method(function() {
    this._boxModelHighlighter.hide();
  }, {
    request: {}
  }),

  /**
   * Start showing the box model highlighter on hover of the content document.
   * That means the highlighter will be displayed on mouseover'd nodes.
   * Events will be triggered when nodes received mouseover and click events.
   */
  startHoveringMode: method(function() {
    this._startHoveringMode();
  }, {
    request: {}
  }),

  /**
   * Stop showing the box model highlighter on hover of the content document.
   */
  stopHoveringMode: method(function() {
    this._stopHoveringMode();
    this._boxModelHighlighter.hide();
  }, {
    request: {}
  }),

  _startHoveringMode: function() {
    if (!this._isHoverModeOn) {
      if (this._isTouch) {
        this._browser.addEventListener("touchstart", this, true);
      } else {
        this._browser.addEventListener("mousemove", this, true);
        this._browser.addEventListener("click", this, true);
        this._browser.addEventListener("dblclick", this, true);
        this._browser.addEventListener("mousedown", this, true);
        this._browser.addEventListener("mouseup", this, true);
      }
      this._isHoverModeOn = true;
    }
  },

  _stopHoveringMode: function() {
    if (this._isHoverModeOn) {
      if (this._isTouch) {
        this._browser.removeEventListener("touchstart", this, true);
      } else {
        this._browser.removeEventListener("mousemove", this, true);
        this._browser.removeEventListener("click", this, true);
        this._browser.removeEventListener("dblclick", this, true);
        this._browser.removeEventListener("mousedown", this, true);
        this._browser.removeEventListener("mouseup", this, true);
      }
      this._isHoverModeOn = false;
    }
  },

  /**
   * Handle all mouse events while inspecting.
   * Highlight the box model on mouseover, and stop highlighting on click.
   * The whole time firing events
   */
  handleEvent: function(event) {
    switch (event.type) {
      case "touchstart":
      case "click":
        // Stop inspecting on touchstart and click on a node
        let util = this.window.QueryInterface(Ci.nsIInterfaceRequestor)
          .getInterface(Ci.nsIDOMWindowUtils);

        let x, y;
        if (this._isTouch) {
          x = event.touches[0].clientX;
          y = event.touches[0].clientY;
        } else {
          x = event.clientX;
          y = event.clientY;
        }

        let element = util.elementFromPoint(x, y, false, false);

        events.emit(this, "node-picked", element);
        event.preventDefault();
        event.stopPropagation();
        break;
      case "mousemove":
        // Highlight on mousemove, making sure we only highlight nodes from the
        // content document
        let doc = event.target.ownerDocument;
        if (doc && doc != this.tabActor._tabbrowser.ownerDocument) {
          let element = this._layoutHelpers.getElementFromPoint(
            event.target.ownerDocument, event.clientX, event.clientY);
          if (element) {
            this._boxModelHighlighter.show(element);
            events.emit(this, "node-hovered");
          }
        }
        break;
      case "dblclick":
      case "mousedown":
      case "mouseup":
        event.stopPropagation();
        event.preventDefault();
        break;
    }
  }
});

exports.HighlighterActor = HighlighterActor;

/**
 * The HighlighterFront class
 */
let HighlighterFront = protocol.FrontClass(HighlighterActor, {
  initialize: function(client, tabForm) {
    protocol.Front.prototype.initialize.call(this, client, tabForm);
    this.actorID = tabForm.highlighterActor;

    // This is the first actor type in its hierarchy to use the protocol
    // library, so we're going to self-own on the client side for now.
    client.addActorPool(this);
    this.manage(this);
  },

  destroy: function() {
    protocol.Front.prototype.destroy.call(this);
  }
});

exports.HighlighterFront = HighlighterFront;

/**
 * The BoxModelHighlighter is the class that actually draws the the box model
 * regions on top of the content document.
 * It is used by the HighlighterActor.
 *
 * The caller is in charge of destroying the highlighter (ie, the highlighter
 * won't be destroyed if a new tab is selected for example).
 *
 * API:
 *
 *   // Constructor and destructor.
 *   BoxModelHighlighter(browser)
 *   void destroy();
 *
 *   // Show and hide the highlighter
 *   void show(node);
 *   void hide();
 *   boolean isHidden();
 *
 *   // Redraw the highlighter if the visible portion of the node has changed.
 *   void invalidateSize(aScroll);
 *
 * Structure:
 *  <stack class="highlighter-container">
 *    <box class="highlighter-outline-container">
 *      <box class="highlighter-outline" locked="true/false"/>
 *    </box>
 *    <box class="highlighter-controls">
 *      <box class="highlighter-nodeinfobar-container" position="top/bottom" locked="true/false">
 *        <box class="highlighter-nodeinfobar-arrow highlighter-nodeinfobar-arrow-top"/>
 *        <hbox class="highlighter-nodeinfobar">
 *          <hbox class="highlighter-nodeinfobar-text">tagname#id.class1.class2</hbox>
 *        </hbox>
 *        <box class="highlighter-nodeinfobar-arrow highlighter-nodeinfobar-arrow-bottom"/>
 *      </box>
 *    </box>
 *  </stack>
 */
function BoxModelHighlighter(tab) {
  this.tab = tab;

  this.browser = this.tab;
  this.chromeDoc = this.tab.ownerDocument;
  this.chromeWin = this.chromeDoc.defaultView;
  this.layoutHelpers = new LayoutHelpers(this.tab.contentWindow);

  this.transitionDisabler = null;
  this.pageEventsMuter = null;
  this._update = this._update.bind(this);
  this.currentNode = null;

  this._initMarkup();
}

BoxModelHighlighter.prototype = {
  _initMarkup: function() {
    let stack = this.browser.parentNode;
    this.win = this.browser.contentWindow;

    this.highlighterContainer = this.chromeDoc.createElement("stack");
    this.highlighterContainer.className = "highlighter-container";

    this.outline = this.chromeDoc.createElement("box");
    this.outline.className = "highlighter-outline";

    let outlineContainer = this.chromeDoc.createElement("box");
    outlineContainer.appendChild(this.outline);
    outlineContainer.className = "highlighter-outline-container";

    // The controlsBox will host the different interactive
    // elements of the highlighter (buttons, toolbars, ...).
    let controlsBox = this.chromeDoc.createElement("box");
    controlsBox.className = "highlighter-controls";
    this.highlighterContainer.appendChild(outlineContainer);
    this.highlighterContainer.appendChild(controlsBox);

    // Insert the highlighter right after the browser
    stack.insertBefore(this.highlighterContainer, stack.childNodes[1]);

    // Building the infobar
    let infobarContainer = this.chromeDoc.createElement("box");
    infobarContainer.className = "highlighter-nodeinfobar-container";
    infobarContainer.setAttribute("position", "top");
    infobarContainer.setAttribute("disabled", "true");

    let nodeInfobar = this.chromeDoc.createElement("hbox");
    nodeInfobar.className = "highlighter-nodeinfobar";

    let arrowBoxTop = this.chromeDoc.createElement("box");
    arrowBoxTop.className = "highlighter-nodeinfobar-arrow highlighter-nodeinfobar-arrow-top";

    let arrowBoxBottom = this.chromeDoc.createElement("box");
    arrowBoxBottom.className = "highlighter-nodeinfobar-arrow highlighter-nodeinfobar-arrow-bottom";

    let tagNameLabel = this.chromeDoc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    tagNameLabel.className = "highlighter-nodeinfobar-tagname";

    let idLabel = this.chromeDoc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    idLabel.className = "highlighter-nodeinfobar-id";

    let classesBox = this.chromeDoc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    classesBox.className = "highlighter-nodeinfobar-classes";

    let pseudoClassesBox = this.chromeDoc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    pseudoClassesBox.className = "highlighter-nodeinfobar-pseudo-classes";

    // Add some content to force a better boundingClientRect
    pseudoClassesBox.textContent = "&nbsp;";

    // <hbox class="highlighter-nodeinfobar-text"/>
    let texthbox = this.chromeDoc.createElement("hbox");
    texthbox.className = "highlighter-nodeinfobar-text";
    texthbox.setAttribute("align", "center");
    texthbox.setAttribute("flex", "1");

    texthbox.appendChild(tagNameLabel);
    texthbox.appendChild(idLabel);
    texthbox.appendChild(classesBox);
    texthbox.appendChild(pseudoClassesBox);

    nodeInfobar.appendChild(texthbox);

    infobarContainer.appendChild(arrowBoxTop);
    infobarContainer.appendChild(nodeInfobar);
    infobarContainer.appendChild(arrowBoxBottom);

    controlsBox.appendChild(infobarContainer);

    let barHeight = infobarContainer.getBoundingClientRect().height;

    this.nodeInfo = {
      tagNameLabel: tagNameLabel,
      idLabel: idLabel,
      classesBox: classesBox,
      pseudoClassesBox: pseudoClassesBox,
      container: infobarContainer,
      barHeight: barHeight,
    };
  },

  /**
   * Destroy the nodes. Remove listeners.
   */
  destroy: function() {
    this.hide();

    this._detachPageListeners();

    this.chromeWin.clearTimeout(this.transitionDisabler);
    this.chromeWin.clearTimeout(this.pageEventsMuter);
    this.boundCloseEventHandler = null;
    this._contentRect = null;
    this._highlightRect = null;
    this.outline = null;
    this.nodeInfo = null;
    this.highlighterContainer.parentNode.removeChild(this.highlighterContainer);
    this.highlighterContainer = null;
    this.win = null
    this.browser = null;
    this.chromeDoc = null;
    this.chromeWin = null;
    this.currentNode = null;
  },

  /**
   * Show the highlighter on a given node
   *
   * @param {DOMNode} node
   */
  show: function(node) {
    if (!this.currentNode || node !== this.currentNode) {
      // Store the currentNode
      this.currentNode = node;

      // Show the highlighter
      this._showInfobar();
      this._computeZoomFactor();
      this._attachPageListeners();
      this._update();

      // Listen for attributes mutations on the element
      this.currentNodeObserver = node.ownerDocument.defaultView.MutationObserver(this._update);
      this.currentNodeObserver.observe(node, {attributes: true});
    }
  },

  /**
   * Update the highlighter on the current highlighted node (the one that was
   * passed as an argument to show(node)).
   * Should be called whenever node size or attributes change
   */
  _update: function() {
    if (this.currentNode) {
      let clientRect = this.currentNode.getBoundingClientRect();
      let rect = this.layoutHelpers.getDirtyRect(this.currentNode);

      if (this._highlightRectangle(rect)) {
        this._moveInfobar();
        this._showOutline();
        this._updateInfobar();
      } else {
        // Nothing to highlight (0px rectangle like a <script> tag for instance)
        this.hide();
      }
    }
  },

  /**
   * Hide the highlighter, the outline and the infobar.
   */
  hide: function() {
    if (this.currentNode) {
      if (this.currentNodeObserver) {
        this.currentNodeObserver.disconnect();
        this.currentNodeObserver = null;
      }

      this.currentNode = null;
      this._hideOutline();
      this._hideInfobar();
      this._detachPageListeners();
      this.chromeWin.focus();
    }
  },

  /**
   * Hide the infobar
   */
  _hideInfobar: function() {
    this.nodeInfo.container.setAttribute("force-transitions", "true");
    this.nodeInfo.container.setAttribute("hidden", "true");
  },

  /**
   * Show the infobar
   */
  _showInfobar: function() {
    this.nodeInfo.container.removeAttribute("hidden");
    this._moveInfobar();
    this.nodeInfo.container.removeAttribute("force-transitions");
  },

  /**
   * Hide the outline
   */
  _hideOutline: function() {
    this.outline.setAttribute("hidden", "true");
  },

  /**
   * Show the outline
   */
  _showOutline: function() {
    this.outline.removeAttribute("hidden");
  },

  /**
   * Highlight a rectangular region.
   *
   * @param {object} aRect
   *        The rectangle region to highlight.
   * @return boolean
   *         True if the rectangle was highlighted, false otherwise.
   */
  _highlightRectangle: function(aRect) {
    if (!aRect) {
      return false;
    }

    let oldRect = this._contentRect;

    if (oldRect && aRect.top == oldRect.top && aRect.left == oldRect.left &&
        aRect.width == oldRect.width && aRect.height == oldRect.height) {
      return true; // same rectangle
    }

    let aRectScaled = this.layoutHelpers.getZoomedRect(this.win, aRect);

    if (aRectScaled.left >= 0 && aRectScaled.top >= 0 &&
        aRectScaled.width > 0 && aRectScaled.height > 0) {

      this._showOutline();

      // The bottom div and the right div are flexibles (flex=1).
      // We don't need to resize them.
      let top = "top:" + aRectScaled.top + "px;";
      let left = "left:" + aRectScaled.left + "px;";
      let width = "width:" + aRectScaled.width + "px;";
      let height = "height:" + aRectScaled.height + "px;";
      this.outline.setAttribute("style", top + left + width + height);
      this._contentRect = aRect; // save orig (non-scaled) rect
      this._highlightRect = aRectScaled; // and save the scaled rect.

      return true;
    } else {
      return false;
    }
  },

  /**
   * Update node information (tagName#id.class)
   */
  _updateInfobar: function() {
    if (this.currentNode) {
      // Tag name
      this.nodeInfo.tagNameLabel.textContent = this.currentNode.tagName;

      // ID
      this.nodeInfo.idLabel.textContent = this.currentNode.id ? "#" + this.currentNode.id : "";

      // Classes
      let classes = this.nodeInfo.classesBox;

      classes.textContent = this.currentNode.classList.length ?
                              "." + Array.join(this.currentNode.classList, ".") : "";

      // Pseudo-classes
      let pseudos = PSEUDO_CLASSES.filter(pseudo => {
        return DOMUtils.hasPseudoClassLock(this.currentNode, pseudo);
      }, this);

      let pseudoBox = this.nodeInfo.pseudoClassesBox;
      pseudoBox.textContent = pseudos.join("");
    }
  },

  /**
   * Move the Infobar to the right place in the highlighter.
   */
  _moveInfobar: function() {
    if (this._highlightRect) {
      let winHeight = this.win.innerHeight * this.zoom;
      let winWidth = this.win.innerWidth * this.zoom;

      let rect = {top: this._highlightRect.top,
                  left: this._highlightRect.left,
                  width: this._highlightRect.width,
                  height: this._highlightRect.height};

      rect.top = Math.max(rect.top, 0);
      rect.left = Math.max(rect.left, 0);
      rect.width = Math.max(rect.width, 0);
      rect.height = Math.max(rect.height, 0);

      rect.top = Math.min(rect.top, winHeight);
      rect.left = Math.min(rect.left, winWidth);

      this.nodeInfo.container.removeAttribute("disabled");
      // Can the bar be above the node?
      if (rect.top < this.nodeInfo.barHeight) {
        // No. Can we move the toolbar under the node?
        if (rect.top + rect.height +
            this.nodeInfo.barHeight > winHeight) {
          // No. Let's move it inside.
          this.nodeInfo.container.style.top = rect.top + "px";
          this.nodeInfo.container.setAttribute("position", "overlap");
        } else {
          // Yes. Let's move it under the node.
          this.nodeInfo.container.style.top = rect.top + rect.height + "px";
          this.nodeInfo.container.setAttribute("position", "bottom");
        }
      } else {
        // Yes. Let's move it on top of the node.
        this.nodeInfo.container.style.top =
          rect.top - this.nodeInfo.barHeight + "px";
        this.nodeInfo.container.setAttribute("position", "top");
      }

      let barWidth = this.nodeInfo.container.getBoundingClientRect().width;
      let left = rect.left + rect.width / 2 - barWidth / 2;

      // Make sure the whole infobar is visible
      if (left < 0) {
        left = 0;
        this.nodeInfo.container.setAttribute("hide-arrow", "true");
      } else {
        if (left + barWidth > winWidth) {
          left = winWidth - barWidth;
          this.nodeInfo.container.setAttribute("hide-arrow", "true");
        } else {
          this.nodeInfo.container.removeAttribute("hide-arrow");
        }
      }
      this.nodeInfo.container.style.left = left + "px";
    } else {
      this.nodeInfo.container.style.left = "0";
      this.nodeInfo.container.style.top = "0";
      this.nodeInfo.container.setAttribute("position", "top");
      this.nodeInfo.container.setAttribute("hide-arrow", "true");
    }
  },

  /**
   * Store page zoom factor.
   */
  _computeZoomFactor: function() {
    this.zoom =
      this.win.QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIDOMWindowUtils)
      .fullZoom;
  },

  _attachPageListeners: function() {
    this.browser.addEventListener("resize", this, true);
    this.browser.addEventListener("scroll", this, true);
    this.browser.addEventListener("MozAfterPaint", this, true);
  },

  _detachPageListeners: function() {
    this.browser.removeEventListener("resize", this, true);
    this.browser.removeEventListener("scroll", this, true);
    this.browser.removeEventListener("MozAfterPaint", this, true);
  },

  /**
   * Generic event handler.
   *
   * @param nsIDOMEvent aEvent
   *        The DOM event object.
   */
  handleEvent: function(event) {
    switch (event.type) {
      case "resize":
        this._computeZoomFactor();
        break;
      case "MozAfterPaint":
      case "scroll":
        this._brieflyDisableTransitions();
        this._update();
        break;
    }
  },

  /**
   * Disable the CSS transitions for a short time to avoid laggy animations
   * during scrolling or resizing.
   */
  _brieflyDisableTransitions: function() {
    if (this.transitionDisabler) {
      this.chromeWin.clearTimeout(this.transitionDisabler);
    } else {
      this.outline.setAttribute("disable-transitions", "true");
      this.nodeInfo.container.setAttribute("disable-transitions", "true");
    }
    this.transitionDisabler =
      this.chromeWin.setTimeout(() => {
        this.outline.removeAttribute("disable-transitions");
        this.nodeInfo.container.removeAttribute("disable-transitions");
        this.transitionDisabler = null;
      }, 500);
  }
};

/**
 * The SimpleOutlineHighlighter is the class that has the same API as the
 * BoxModelHighlighter, but adds a pseudo-class on the target element itself
 * to draw a simple outline.
 * It is used by the HighlighterActor too, but in case the more complex
 * BoxModelHighlighter can't be attached (which is the case for FirefoxOS and
 * Fennec targets for instance).
 */
function SimpleOutlineHighlighter(tab) {
  this.tab = tab;

  this.browser = this.tab;
  this.chromeDoc = this.tab.ownerDocument;
  this.chromeWin = this.chromeDoc.defaultView;
}

SimpleOutlineHighlighter.prototype = {
  /**
   * Destroy the nodes. Remove listeners.
   */
  destroy: function() {
    this.hide();
  },

  _installHelperSheet: function(node) {
    if (!this.installedHelpers) {
      this.installedHelpers = new WeakMap;
    }
    let win = node.ownerDocument.defaultView;
    if (!this.installedHelpers.has(win)) {
      let { Style } = require("sdk/stylesheet/style");
      let { attach } = require("sdk/content/mod");
      let style = Style({source: HELPER_SHEET, type: "agent" });
      attach(style, win);
      this.installedHelpers.set(win, style);
    }
  },

  /**
   * Show the highlighter on a given node
   *
   * @param {DOMNode} node
   */
  show: function(node) {
    if (!this.currentNode || node !== this.currentNode) {
      // Store the currentNode
      this.currentNode = node;

      this._installHelperSheet(node);
      DOMUtils.addPseudoClassLock(node, HIGHLIGHTED_PSEUDO_CLASS);
    }
  },

  /**
   * Hide the highlighter, the outline and the infobar.
   */
  hide: function() {
    if (this.currentNode) {
      this.currentNode = null;
      let nodes = this.chromeDoc.querySelectorAll(HIGHLIGHTED_PSEUDO_CLASS);
      for (let node of nodes) {
        DOMUtils.removePseudoClassLock(node, HIGHLIGHTED_PSEUDO_CLASS);
      }
    }
  }
};

XPCOMUtils.defineLazyGetter(this, "DOMUtils", function () {
  return Cc["@mozilla.org/inspector/dom-utils;1"].getService(Ci.inIDOMUtils)
});
