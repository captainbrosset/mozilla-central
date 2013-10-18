/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {Cc, Cu, Ci} = require("chrome");
const promise = require("sdk/core/promise");
const IOService = Cc["@mozilla.org/network/io-service;1"]
  .getService(Ci.nsIIOService);
const {Spectrum} = require("devtools/shared/widgets/Spectrum");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/devtools/ViewHelpers.jsm");

const GRADIENT_RE = /\b(repeating-)?(linear|radial)-gradient\(((rgb|hsl)a?\(.+?\)|[^\)])+\)/gi;
const BORDERCOLOR_RE = /^border-[-a-z]*color$/ig;
const BORDER_RE = /^border(-(top|bottom|left|right))?$/ig;
const BACKGROUND_IMAGE_RE = /url\([\'\"]?(.*?)[\'\"]?\)/;
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Tooltip widgets.
 *
 * These widgets are intended at any tool that may need to show rich previews.
 * A common use case is image previewing in the CSS rule view.
 *
 * Tooltips are based on XUL (namely XUL arrow-type <panel>s), and therefore
 * need a XUL Document to live in.
 * This is pretty much the only requirement they have on their environment.
 *
 * The way to use a tooltip is simply by instantiating a tooltip yourself or
 * using the tooltip factory to get ready made tooltips.
 *
 * A convenient `toggleOnHover` method may avoid having to register event
 * handlers yourself if the tooltip has to be shown when hovering over an
 * element
 *
 * Behind the tooltip classes sits a PanelFactory which creates XUL panels and
 * makes sure there is only one panel per XUL document.
 */

/**
 * The low level structure of a tooltip is a XUL element (a <panel>, although
 * <tooltip> is supported too, it won't have the nice arrow shape).
 * We try to share tooltips as much as possible. So when one is requested for a
 * given XUL document, we return the one in that document if any, otherwise we
 * create and append one.
 */
let PanelFactory = {
  els: new Map(),

  get: function(doc, xulTag="panel") {
    // FIXME: just investigating something
    return this._create(doc, xulTag);
    // The problem is: if several really different kinds of tooltip share the same xul panel, there may be problems.
    // Especially if one wants to toggleOnHover and the other not, because that means everytime you move over the baseNode
    // the tooltip will hide even though you may not want it.
    // Also, some tooltip will contain heavy stuff that don't need to change, so emptying and re-creating the content everytime may not be wanted
    // Perhaps one way would be to have 2 modes when creating a tooltip: weakTooltip, shared, short-lived content, and RealTooltips, your own, never shared, content stays
    // Or maybe we don't care and we just create a panel everytime
    // --> YES, let's go for this

    // Code here
    if (this.els.has(doc)) {
      return this.els.get(doc);
    } else {
      let tooltip = this._create(doc, xulTag);
      this.els.set(doc, tooltip);
      return tooltip;
    }
  },

  _create: function(doc, xulTag) {
    // Create the tooltip
    let tooltip = doc.createElement(xulTag);
    tooltip.setAttribute("hidden", true);

    if (xulTag === "panel") {
      // Prevent the click used to close the panel from being consumed
      tooltip.setAttribute("consumeoutsideclicks", false);
      tooltip.setAttribute("type", "arrow");
      tooltip.setAttribute("level", "top");
    }

    tooltip.setAttribute("class", "devtools-tooltip devtools-tooltip-" + xulTag);
    doc.querySelector("window").appendChild(tooltip);

    return tooltip;
  }
};

module.exports.PanelFactory = PanelFactory;

/**
 * Tooltip class.
 *
 * Basic usage:
 *   let t = new Tooltip(xulDoc);
 *   t.tooltip.content = someXulContent;
 *   t.show();
 *   t.hide();
 *   t.destroy();
 *
 * Better usage:
 *   let t = new Tooltip(xulDoc);
 *   t.toggleOnHover(container, target => {
 *     if (<condition based on target>) {
 *       t.contentFactory.image("http://image.png");
 *       return true;
 *     }
 *   });
 *   t.destroy();
 *
 * @param XULDocument doc
 *        The XUL document hosting this tooltip
 */
function Tooltip(doc) {
  this.doc = doc;
  this.tooltip = PanelFactory.get(doc);
  this._storedContent = null;

  this.uid = "tooltip-" + Date.now();

  this.contentFactory = new TooltipContentFactory(this);
}

module.exports.Tooltip = Tooltip;

Tooltip.prototype = {
  /**
   * Show the tooltip. It might be wise to append some content first if you
   * don't want the tooltip to be empty. You may access the content of the
   * tooltip by setting a XUL node to t.content.
   * @param node anchor
   *        Which node should the tooltip be shown on
   * @param string position
   *        https://developer.mozilla.org/en-US/docs/XUL/PopupGuide/Positioning
   *        Defaults to before_start
   */
  show: function(anchor, position="before_start") {
    // FIXME: deal with this. The best would probably be to create one panel
    // per instance, and never change the content.

    // if (this._storedContent) {
    //   this.content = this._storedContent;
    // }
    this.tooltip.hidden = false;
    this.tooltip.openPopup(anchor, position);
  },

  /**
   * Hide the tooltip
   */
  hide: function() {
    this.tooltip.hidden = true;
    this.tooltip.hidePopup();
  },

  toggle: function(anchor, position="before_start") {
    if (this.tooltip.hidden) {
      this.show(anchor, position);
    } else {
      this.hide();
    }
  },

  /**
   * Empty the tooltip's content
   */
  empty: function() {
    while (this.tooltip.hasChildNodes()) {
      this.tooltip.removeChild(this.tooltip.firstChild);
    }
  },

  /**
   * Get rid of references for GC
   */
  destroy: function () {
    this.hide();
    this.content = null;

    this.doc = null;
    this.tooltip = null;

    if (this._basedNode) {
      this.stopTogglingOnHover();
    }
  },

  /**
   * Set the content of this tooltip. Will first empty the tooltip and then
   * append the new content element
   * @param node content
   *        A node that can be appended in the tooltip XUL element
   */
  set content(content) {
    this._storedContent = content;
    this.empty();
    if (content) {
      this.tooltip.appendChild(content);
    }
  },

  get content() {
    return this._storedContent;
  },

  /**
   * Show/hide the tooltip when the mouse hovers over particular nodes.
   *
   * 2 Ways to make this work:
   * - Provide a single node to attach the tooltip to, as the baseNode, and
   *   omit the second targetNodeCb argument
   * - Provide a baseNode that is the container of possibly numerous children
   *   elements that may receive a tooltip. In this case, provide the second
   *   targetNodeCb argument to decide wether or not a child should receive
   *   a tooltip.
   *
   * This works by tracking mouse movements on a base container node (baseNode)
   * and showing the tooltip when the mouse stops moving. The targetNodeCb
   * callback is used to know whether or not the particular element being
   * hovered over should indeed receive the tooltip. If you don't provide it
   * it's equivalent to a function that always returns true.
   *
   * @param node baseNode
   *        The container for all target nodes
   * @param Function targetNodeCb
   *        A function that accepts a node argument and returns true or false
   *        to signify if the tooltip should be shown on that node or not.
   *        Additionally, the function receives a second argument which is the
   *        tooltip instance itself, to be used to add/modify the content of the
   *        tooltip if needed. If omitted, the tooltip will be shown everytime.
   * @param Number showDelay
   *        An optional delay that will be observed before showing the tooltip.
   *        Defaults to 750ms
   */
  toggleOnHover: function(baseNode, targetNodeCb, showDelay = 750) {
    this._basedNode = baseNode;
    this._showDelay = showDelay;
    this._targetNodeCb = targetNodeCb || (() => true);

    this._onBaseNodeMouseMove = this._onBaseNodeMouseMove.bind(this);
    this._onBaseNodeMouseLeave = this._onBaseNodeMouseLeave.bind(this);

    baseNode.addEventListener("mousemove", this._onBaseNodeMouseMove, false);
    baseNode.addEventListener("mouseleave", this._onBaseNodeMouseLeave, false);
  },

  /**
   * If the toggleOnHover function has been used previously, and you want to get
   * rid of this behavior, then call this function to remove the mouse movement
   * tracking
   * @param node baseNode
   *        The container for all target nodes
   */
  stopTogglingOnHover: function(baseNode) {
    clearNamedTimeout(this.uid);

    this._basedNode.removeEventListener("mousemove",
      this._onBaseNodeMouseMove, false);
    this._basedNode.removeEventListener("mouseleave",
      this._onBaseNodeMouseLeave, false);

    this._basedNode = null;
    this._lastHovered = null;
  },

  _onBaseNodeMouseMove: function(event) {
    if (event.target !== this._lastHovered) {
      this.hide();
      this._lastHovered = null;
      setNamedTimeout(this.uid, this._showDelay, () => {
        if (this._targetNodeCb(event.target, this)) {
          this.show(event.target);
          this._lastHovered = event.target;
        }
      });
    }
  },

  _onBaseNodeMouseLeave: function() {
    clearNamedTimeout(this.uid);
    this._lastHovered = null;
  }
};

/**
 * The tooltip content factory helps filling in the tooltip with ready-made
 * content. Browse through the public methods provided here to see what kind of
 * content is already available.
 *
 * You do not need to instantiate a factory yourself, each tooltip comes with
 * one on the tooltip.contentFactory property.
 *
 * Usage example:
 *   let t = new Tooltip(xulDoc);
 *   t.contentFactory.image("myImg.png", 600);
 *   t.show();
 */
function TooltipContentFactory(tooltip) {
  this.tooltip = tooltip;
  this.doc = this.tooltip.doc;
};

TooltipContentFactory.prototype = {
  /**
   * Fill the tooltip with an image, displayed over a tiled background useful
   * for transparent images.
   * Also adds the image dimension as a label at the bottom.
   */
  image: function(imageUrl, maxDim=400) {
    // Main container
    let vbox = this.doc.createElement("vbox");
    vbox.setAttribute("align", "center")

    // Transparency tiles (image will go in there)
    let tiles = createTransparencyTiles(this.doc, vbox);

    // Temporary label during image load
    let label = this.doc.createElement("label");
    label.classList.add("devtools-tooltip-caption");
    label.textContent = l10n.strings.GetStringFromName("previewTooltip.image.brokenImage");
    vbox.appendChild(label);

    this.tooltip.content = vbox;

    // Load the image to get dimensions and display it when done
    let imgObj = new this.doc.ownerGlobal.Image();
    imgObj.src = imageUrl;
    imgObj.onload = () => {
      imgObj.onload = null;

      // Display dimensions
      label.textContent = imgObj.naturalWidth + " x " + imgObj.naturalHeight;
      if (imgObj.naturalWidth > maxDim ||
        imgObj.naturalHeight > maxDim) {
        label.textContent += " *";
      }

      // Display the image
      let image = this.doc.createElement("image");
      image.setAttribute("src", imageUrl);
      if (maxDim) {
        image.style.maxWidth = maxDim + "px";
        image.style.maxHeight = maxDim + "px";
      }
      tiles.appendChild(image);
    }
  },

  /**
   * Exactly the same as the `image` function but takes a css background image
   * value instead : url(....)
   */
  cssBackgroundImage: function(cssBackgroundImage, sheetHref, maxDim=400) {
    let uri = getBackgroundImageUri(cssBackgroundImage, sheetHref);
    if (uri) {
      this.image(uri, maxDim);
    }
  },

  cssGradient: function(cssGradient) {
    let tiles = createTransparencyTiles(this.doc);

    let gradientBox = this.doc.createElement("box");
    gradientBox.width = "100";
    gradientBox.height = "100";
    gradientBox.style.background = this.cssGradient;
    gradientBox.style.borderRadius = "2px";
    gradientBox.style.boxShadow = "inset 0 0 4px #333";

    tiles.appendChild(gradientBox)

    this.tooltip.content = tiles;
  },

  _simpleCssProperties: function(properties, width, height) {
    let tiles = createTransparencyTiles(this.doc);

    let box = this.doc.createElement("box");
    box.width = width + "";
    box.height = height + "";
    properties.forEach(({name, value}) => {
      box.style[name] = value;
    });
    tiles.appendChild(box);

    this.tooltip.content = tiles;
  },

  cssColor: function(cssColor) {
    this._simpleCssProperties([
      {name: "background", value: cssColor},
      {name: "borderRadius", value: "2px"},
      {name: "boxShadow", value: "inset 0 0 4px #333"},
    ], 50, 50);
  },

  cssBoxShadow: function(cssBoxShadow) {
    this._simpleCssProperties([
      {name: "background", value: "white"},
      {name: "boxShadow", value: cssBoxShadow}
    ], 80, 80);
  },

  cssBorder: function(cssBorder) {
    this._simpleCssProperties([
      {name: "background", value: "white"},
      {name: "border", value: cssBorder}
    ], 80, 80);
  },

  /**
   * Fill the tooltip with a new instance of the spectrum color picker widget
   * initialized with the given color, and return a promise that resolves to
   * the instance of spectrum
   */
  spectrum: function(color) {
    let def = promise.defer();

    // Create an iframe to contain spectrum
    let iframe = this.doc.createElementNS(XHTML_NS, "iframe");
    iframe.setAttribute("transparent", true);
    iframe.setAttribute("width", "210");
    iframe.setAttribute("height", "195");
    iframe.setAttribute("flex", "1");
    iframe.setAttribute("class", "devtools-tooltip-iframe");

    let panel = this.tooltip.tooltip;
    let xulWin = this.doc.ownerGlobal;

    // Wait for the load to initialize spectrum
    function onLoad() {
      iframe.removeEventListener("load", onLoad, true);
      let win = iframe.contentWindow.wrappedJSObject;

      let container = win.document.getElementById("spectrum");
      let spectrum = new Spectrum(container, color);

      // Finalize spectrum's init when the tooltip becomes visible
      panel.addEventListener("popupshown", function shown() {
        panel.removeEventListener("popupshown", shown, true);
        spectrum.show();
        def.resolve(spectrum);
      }, true);
    }
    iframe.addEventListener("load", onLoad, true);
    iframe.setAttribute("src", "chrome://browser/content/devtools/spectrum-frame.xhtml");

    // Put the iframe in the tooltip
    this.tooltip.content = iframe;

    return def.promise;
  }
};

/**
 * Internal utility function that creates a tiled background useful for
 * displaying semi-transparent images
 */
function createTransparencyTiles(doc, parentEl) {
  let tiles = doc.createElement("box");
  tiles.classList.add("devtools-tooltip-tiles");
  if (parentEl) {
    parentEl.appendChild(tiles);
  }
  return tiles;
}

/**
 * Internal util, checks whether a css declaration is a gradient
 */
function isGradientRule(property, value) {
  return (property === "background" || property === "background-image") &&
    value.match(GRADIENT_RE);
}

/**
 * Internal util, checks whether a css declaration is a color
 */
function isColorOnly(property, value) {
  return property === "background-color" ||
         property === "color" ||
         property.match(BORDERCOLOR_RE);
}

/**
 * Internal util, returns the background image uri if any
 */
function getBackgroundImageUri(value, sheetHref) {
  let uriMatch = BACKGROUND_IMAGE_RE.exec(value);
  let uri = null;

  if (uriMatch && uriMatch[1]) {
    uri = uriMatch[1];
    if (sheetHref) {
      let sheetUri = IOService.newURI(sheetHref, null, null);
      uri = sheetUri.resolve(uri);
    }
  }

  return uri;
}

/**
 * L10N utility class
 */
function L10N() {}
L10N.prototype = {};

let l10n = new L10N();

loader.lazyGetter(L10N.prototype, "strings", () => {
  return Services.strings.createBundle(
    "chrome://browser/locale/devtools/inspector.properties");
});
