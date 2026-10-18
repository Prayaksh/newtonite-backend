CREATE TABLE "NotificationRead" (
    "userId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("userId", "activityId")
);

CREATE INDEX "NotificationRead_activityId_idx" ON "NotificationRead"("activityId");

ALTER TABLE "NotificationRead"
ADD CONSTRAINT "NotificationRead_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationRead"
ADD CONSTRAINT "NotificationRead_activityId_fkey"
FOREIGN KEY ("activityId") REFERENCES "Activity"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
