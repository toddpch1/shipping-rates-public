-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShippingChart" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "basisType" TEXT NOT NULL DEFAULT 'MERCHANDISE_PRE_DISCOUNT',
    "requireAllItemsMatch" BOOLEAN NOT NULL DEFAULT false,
    "capPercentOfMax" INTEGER NOT NULL DEFAULT 90,
    "handlingFeeCents" INTEGER NOT NULL DEFAULT 0,
    "defaultServiceCode" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShippingChart" ("basisType", "capPercentOfMax", "createdAt", "handlingFeeCents", "id", "isActive", "name", "priority", "requireAllItemsMatch", "shop", "updatedAt") SELECT "basisType", "capPercentOfMax", "createdAt", "handlingFeeCents", "id", "isActive", "name", "priority", "requireAllItemsMatch", "shop", "updatedAt" FROM "ShippingChart";
DROP TABLE "ShippingChart";
ALTER TABLE "new_ShippingChart" RENAME TO "ShippingChart";
CREATE INDEX "ShippingChart_shop_isActive_idx" ON "ShippingChart"("shop", "isActive");
CREATE INDEX "ShippingChart_shop_priority_idx" ON "ShippingChart"("shop", "priority");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
