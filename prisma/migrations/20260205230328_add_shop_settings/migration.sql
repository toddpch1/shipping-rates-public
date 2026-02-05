-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "managedZoneIdsJson" TEXT NOT NULL DEFAULT '[]',
    "zonesSnapshotJson" TEXT NOT NULL DEFAULT '{}',
    "servicesSnapshotJson" TEXT NOT NULL DEFAULT '{}',
    "lastSyncedAt" DATETIME,
    "lastSyncError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
