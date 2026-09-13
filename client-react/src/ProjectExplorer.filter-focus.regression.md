# ProjectExplorer filtered-tree focus regression

## Bug
If keyboard focus is on a tree item and the user changes the filter so that the focused item is no longer visible, `activePath` remains set to the hidden item. Every visible treeitem then receives `tabIndex={-1}` because the first-item fallback only applies when `activePath` is null. The tree container itself is `tabIndex=-1`, so keyboard users can lose the tree's tab stop and cannot re-enter the filtered tree with Tab.

## Expected behavior
When filtering hides the active tree item:
- clear or replace `activePath` with a visible item;
- exactly one visible treeitem must have `tabIndex=0` when the filtered tree is non-empty;
- the first visible item is a safe fallback if the prior active item is no longer visible.

## Regression test
Render a tree with at least two items. Focus one item, change the filter so that item is hidden while another item remains visible, then assert:
- the hidden item is absent;
- the remaining visible treeitem has `tabIndex="0"`;
- keyboard navigation can continue from that item.

## Scope
Keep the fix limited to ProjectExplorer active-path/focus behavior during filtering. Do not change selection semantics, tree position semantics, virtualization, or preview-dialog behavior.
