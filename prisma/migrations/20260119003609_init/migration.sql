-- CreateTable
CREATE TABLE "ShippingChart" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "basisType" TEXT NOT NULL DEFAULT 'MERCHANDISE_PRE_DISCOUNT',
    "requireAllItemsMatch" BOOLEAN NOT NULL DEFAULT false,
    "capPercentOfMax" INTEGER NOT NULL DEFAULT 90,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShippingTier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chartId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minCents" INTEGER NOT NULL DEFAULT 0,
    "maxCents" INTEGER,
    "priceType" TEXT NOT NULL DEFAULT 'FLAT',
    "flatPriceCents" INTEGER,
    "percentBps" INTEGER,
    "serviceCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShippingTier_chartId_fkey" FOREIGN KEY ("chartId") REFERENCES "ShippingChart" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShippingSelector" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chartId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShippingSelector_chartId_fkey" FOREIGN KEY ("chartId") REFERENCES "ShippingChart" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ShippingChart_shop_isActive_idx" ON "ShippingChart"("shop", "isActive");

-- CreateIndex
CREATE INDEX "ShippingChart_shop_priority_idx" ON "ShippingChart"("shop", "priority");

-- CreateIndex
CREATE INDEX "ShippingTier_chartId_isActive_idx" ON "ShippingTier"("chartId", "isActive");

-- CreateIndex
CREATE INDEX "ShippingTier_chartId_sortOrder_idx" ON "ShippingTier"("chartId", "sortOrder");

-- CreateIndex
CREATE INDEX "ShippingSelector_chartId_mode_idx" ON "ShippingSelector"("chartId", "mode");

-- CreateIndex
CREATE INDEX "ShippingSelector_chartId_type_idx" ON "ShippingSelector"("chartId", "type");
