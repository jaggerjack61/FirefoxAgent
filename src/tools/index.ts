/**
 * Assembles the complete tool registry with all tools and their
 * confirmation flags. This is the single source of truth for what the
 * agent can do.
 */

import { ToolRegistry } from "./ToolRegistry";

export { ToolRegistry };
export type { AgentTool } from "./ToolRegistry";
import {
  listTabsTool,
  getActiveTabTool,
  getTabTool,
  switchTabTool,
  openTabTool,
  closeTabTool,
  closeTabsTool,
  reloadTabTool,
  duplicateTabTool,
  goBackTool,
  goForwardTool,
  restoreClosedTabTool,
  undoLastActionTool,
} from "./tabTools";
import {
  getPageMetadataTool,
  getPageTextTool,
  getVisibleTextTool,
  getPageStructureTool,
  getLinksTool,
  getFormsTool,
  getButtonsTool,
  getInputsTool,
  findTextTool,
  getSnapshotTool,
} from "./pageInspectionTools";
import {
  clickElementTool,
  focusElementTool,
  typeTextTool,
  clearInputTool,
  selectOptionTool,
  checkCheckboxTool,
  uncheckCheckboxTool,
  setCheckboxTool,
  scrollTool,
  scrollToElementTool,
  hoverElementTool,
  pressKeyTool,
  getInputHistoryTool,
  restoreInputTool,
} from "./interactionTools";
import { extractTableTool, extractListTool, extractLinksTool, extractStructuredContentTool } from "./extractionTools";
import { navigateTool, searchWebTool } from "./navigationTools";
import {
  getWorkspaceTabsTool,
  getWorkspaceMemoryTool,
  clearMemoryTool,
  addTabToWorkspaceTool,
  removeTabFromWorkspaceTool,
  rememberFactTool,
  saveTabNotesTool,
  summarizeTabTool,
} from "./workspaceTools";
import { getActionHistoryTool } from "./actionHistoryTool";

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Tab management
  registry.register(listTabsTool);
  registry.register(getActiveTabTool);
  registry.register(getTabTool);
  registry.register(switchTabTool);
  registry.register(openTabTool);
  registry.register(closeTabTool);
  registry.register(closeTabsTool);
  registry.register(reloadTabTool);
  registry.register(duplicateTabTool);
  registry.register(goBackTool);
  registry.register(goForwardTool);
  registry.register(restoreClosedTabTool);
  registry.register(undoLastActionTool);

  // Page inspection
  registry.register(getPageMetadataTool);
  registry.register(getPageTextTool);
  registry.register(getVisibleTextTool);
  registry.register(getPageStructureTool);
  registry.register(getLinksTool);
  registry.register(getFormsTool);
  registry.register(getButtonsTool);
  registry.register(getInputsTool);
  registry.register(findTextTool);
  registry.register(getSnapshotTool);

  // Interaction
  registry.register(clickElementTool);
  registry.register(focusElementTool);
  registry.register(typeTextTool);
  registry.register(clearInputTool);
  registry.register(selectOptionTool);
  registry.register(checkCheckboxTool);
  registry.register(uncheckCheckboxTool);
  registry.register(setCheckboxTool);
  registry.register(scrollTool);
  registry.register(scrollToElementTool);
  registry.register(hoverElementTool);
  registry.register(pressKeyTool);
  registry.register(getInputHistoryTool);
  registry.register(restoreInputTool);

  // Extraction
  registry.register(extractTableTool);
  registry.register(extractListTool);
  registry.register(extractLinksTool);
  registry.register(extractStructuredContentTool);

  // Navigation / search
  registry.register(navigateTool);
  registry.register(searchWebTool);

  // Workspace & memory
  registry.register(getWorkspaceTabsTool);
  registry.register(getWorkspaceMemoryTool);
  registry.register(clearMemoryTool);
  registry.register(addTabToWorkspaceTool);
  registry.register(removeTabFromWorkspaceTool);
  registry.register(rememberFactTool);
  registry.register(saveTabNotesTool);
  registry.register(summarizeTabTool);

  // History
  registry.register(getActionHistoryTool);

  return registry;
}
