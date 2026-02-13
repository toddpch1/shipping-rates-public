-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "managedZoneIdsJson" TEXT NOT NULL DEFAULT '[]',
    "managedZoneConfigJson" TEXT NOT NULL DEFAULT '[]',
    "zonesSnapshotJson" TEXT NOT NULL DEFAULT '{}',
    "servicesSnapshotJson" TEXT NOT NULL DEFAULT '{}',
    "lastSyncedAt" DATETIME,
    "lastSyncError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "managedServiceIdsJson" TEXT DEFAULT '[]',
    "volumeDiscountLabel" TEXT NOT NULL DEFAULT 'Volume Pricing',
    "volumePricingSnapshotJson" TEXT NOT NULL DEFAULT '{}',
    "volumePricingSnapshotVersion" INTEGER NOT NULL DEFAULT 1,
    "volumePricingLastSyncedAt" DATETIME,
    "volumePricingLastSyncError" TEXT
);
INSERT INTO "new_ShopSettings" ("createdAt", "id", "lastSyncError", "lastSyncedAt", "managedServiceIdsJson", "managedZoneConfigJson", "managedZoneIdsJson", "servicesSnapshotJson", "shop", "updatedAt", "zonesSnapshotJson") SELECT "createdAt", "id", "lastSyncError", "lastSyncedAt", "managedServiceIdsJson", "managedZoneConfigJson", "managedZoneIdsJson", "servicesSnapshotJson", "shop", "updatedAt", "zonesSnapshotJson" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
