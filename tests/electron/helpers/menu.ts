import type { ElectronApplication } from '@playwright/test';

export async function invokeMenu(app: ElectronApplication, id: 'open-settings' | 'refresh-status' | 'layout-columns4' | 'layout-grid2x2' | 'layout-focus') {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error('Missing native menu item: ' + itemId);
    item.click();
  }, id);
}
