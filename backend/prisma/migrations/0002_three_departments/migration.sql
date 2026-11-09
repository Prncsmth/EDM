-- Simplify to 3 departments + Admin (data steward):
--   PORT_OPS, QC, WAREHOUSE -> OPERATIONS
--   LOGISTICS               -> SALES   (Sales & Logistics)
CREATE TYPE "Department_new" AS ENUM ('ADMIN', 'OPERATIONS', 'SALES', 'FINANCE');

ALTER TABLE "User" ALTER COLUMN "department" TYPE "Department_new" USING (
  CASE WHEN "department"::text IN ('PORT_OPS', 'QC', 'WAREHOUSE') THEN 'OPERATIONS' WHEN "department"::text = 'LOGISTICS' THEN 'SALES' ELSE "department"::text END
)::"Department_new";

ALTER TABLE "IntegrationEvent" ALTER COLUMN "sourceDept" TYPE "Department_new" USING (
  CASE WHEN "sourceDept"::text IN ('PORT_OPS', 'QC', 'WAREHOUSE') THEN 'OPERATIONS' WHEN "sourceDept"::text = 'LOGISTICS' THEN 'SALES' ELSE "sourceDept"::text END
)::"Department_new";

ALTER TABLE "IntegrationEvent" ALTER COLUMN "targetDept" TYPE "Department_new" USING (
  CASE WHEN "targetDept"::text IN ('PORT_OPS', 'QC', 'WAREHOUSE') THEN 'OPERATIONS' WHEN "targetDept"::text = 'LOGISTICS' THEN 'SALES' ELSE "targetDept"::text END
)::"Department_new";

ALTER TABLE "DqRule" ALTER COLUMN "ownerDepartment" TYPE "Department_new" USING (
  CASE WHEN "ownerDepartment"::text IN ('PORT_OPS', 'QC', 'WAREHOUSE') THEN 'OPERATIONS' WHEN "ownerDepartment"::text = 'LOGISTICS' THEN 'SALES' ELSE "ownerDepartment"::text END
)::"Department_new";

ALTER TABLE "DqIssue" ALTER COLUMN "department" TYPE "Department_new" USING (
  CASE WHEN "department"::text IN ('PORT_OPS', 'QC', 'WAREHOUSE') THEN 'OPERATIONS' WHEN "department"::text = 'LOGISTICS' THEN 'SALES' ELSE "department"::text END
)::"Department_new";

DROP TYPE "Department";
ALTER TYPE "Department_new" RENAME TO "Department";
