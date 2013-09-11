/* vim: set ts=2 et sw=2 tw=80: */
/* Any copyright is dedicated to the Public Domain.
 http://creativecommons.org/publicdomain/zero/1.0/ */

let {PanelFactory} = devtools.require("devtools/shared/widgets/Tooltip");

let contentDoc;
let inspector;
let ruleView;
let computedView;

const PAGE_CONTENT = [
  '<style type="text/css">',
  '  body {',
  '    padding: 1em;',
  '  }',
  '  div {',
  '    width: 100%;',
  '    background: linear-gradient(to bottom, #efc5ca 0%,#d24b5a 50%,#ba2737 51%,#f18e99 100%);',
  '    font: bold 1em arial;',
  '    padding: 1em;',
  '  }',
  '  .label {',
  '    font-family: verdana;',
  '    background: url(chrome://global/skin/icons/warning-64.png) no-repeat left center;',
  '    padding-left: 70px;',
  '  }',
  '</style>',
  '<div>',
  '  <span class="label">test element</span>',
  '</div>',
].join("\n");

function test() {
  waitForExplicitFinish();

  gBrowser.selectedTab = gBrowser.addTab();
  gBrowser.selectedBrowser.addEventListener("load", function(evt) {
    gBrowser.selectedBrowser.removeEventListener(evt.type, arguments.callee, true);
    contentDoc = content.document;
    waitForFocus(createDocument, content);
  }, true);

  content.location = "data:text/html,rule view tooltip test";
}

function createDocument() {
  contentDoc.body.innerHTML = PAGE_CONTENT;

  openRuleView((aInspector, aRuleView) => {
    inspector = aInspector;
    ruleView = aRuleView;
    startTests();
  });
}

function startTests() {
  let testLabel = contentDoc.querySelector(".label");

  inspector.selection.setNode(testLabel);
  inspector.once("inspector-updated", testMouseOverRuleView);
}

function endTests() {
  contentDoc = inspector = ruleView = computedView = null;
  gBrowser.removeCurrentTab();
  finish();
}

function testMouseOverRuleView() {
  info("Testing tooltips in the rule view");

  [].forEach.call(ruleView.doc.querySelectorAll(".ruleview-property"), property => {
    let nameSpan = property.querySelector(".ruleview-propertyname");
    let valueSpan = property.querySelector(".ruleview-propertyvalue");

    if (nameSpan.textContent === "background") {
      info("We have the background property in the rule view");
      let win = ruleView.doc.defaultView;

      // Test that the tooltip displays when we mouseover
      mouseOverElementAndAssertTooltipVisible(valueSpan, win, testMouseOverComputedView);
    }
  });
}

function testMouseOverComputedView() {
  info("Testing tooltips in the computed view");

  inspector.sidebar.select("computedview");
  computedView = inspector.sidebar.getWindowForTab("computedview").computedview.view;
  let doc = computedView.styleDocument;

  [].forEach.call(doc.querySelectorAll(".property-view"), property => {
    let nameSpan = property.querySelector(".property-name");
    let valueSpan = property.querySelector(".property-value");

    if (nameSpan.textContent === "background-image") {
      info("We have the background-image property in the computed view");
      mouseOverElementAndAssertTooltipVisible(valueSpan, doc.defaultView,
        endTests);
    }
  });
}

function mouseOverElementAndAssertTooltipVisible(e, win, cb) {
  // If the element we're trying to hover over contains a link, then it's a
  // background image source, let's hover over that instead
  if (e.querySelector(".theme-link")) {
    e = e.querySelector(".theme-link");
  }

  e.scrollIntoView();

  let tooltip = PanelFactory.els.get(inspector.panelDoc);
  ok(tooltip, "Tooltip element created");

  let secondChangeMouseMove;

  function tooltipShown() {
    if (secondChangeMouseMove)
      clearTimeout(secondChangeMouseMove);

    tooltip.removeEventListener("popupshown", tooltipShown, false);
    tooltip.addEventListener("popuphidden", tooltipHidden, false);

    info("Tooltip element shown");
    ok(tooltip.childNodes.length > 0, "Tooltip element content filled");

    // Using a setTimeout here to leave the time for the tooltip to be visually
    // displayed (XUL panels appear with an animation and although the doc says
    // the popupshown is fired when the popup is on screen, it's not).
    // This helps debugging.
    setTimeout(() => {
      tooltip.hidden = true;
      tooltip.hidePopup && tooltip.hidePopup();
    }, 200);
  }
  function tooltipHidden() {
    tooltip.removeEventListener("popuphidden", tooltipHidden, false);

    info("Tooltip element hidden");
    executeSoon(cb);
  }
  tooltip.addEventListener("popupshown", tooltipShown, false);

  EventUtils.synthesizeMouseAtCenter(e, {type: "mousemove"}, win);
  // Simulating events that will show the panel doesn't seem to always work
  // depending on the platform. Sometimes, the event may actually not be caught
  // by the handler, so let's try again a second time.
  secondChangeMouseMove = setTimeout(() => {
    EventUtils.synthesizeMouseAtCenter(e, {type: "mousemove"}, win);
  }, 500);
}
