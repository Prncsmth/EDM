import type { Department, DqDimension, DqSeverity } from '@prisma/client';

// The default DQ rules. These are copied into the DqRule table by the seed;
// after that, admins change severity / params / on-off from the DQM Rules page.
export type RuleMeta = {
  code: string;
  name: string;
  description: string;
  dimension: DqDimension;
  entityType: string; // comma-separated when a rule covers several entities
  severity: DqSeverity;
  ownerDepartment: Department;
  checkMode: 'REALTIME' | 'EVENT' | 'BATCH';
  params?: Record<string, number>;
};

export const RULE_CATALOG: RuleMeta[] = [
  {
    code: 'DQ-01', name: 'Fisher payout details complete', dimension: 'COMPLETENESS', entityType: 'Fisher',
    severity: 'BLOCK', ownerDepartment: 'ADMIN', checkMode: 'EVENT',
    description: 'A fisher must have a TIN and a payout method/account before a settlement can be approved.',
  },
  {
    code: 'DQ-02', name: 'Lot complete before storage', dimension: 'COMPLETENESS', entityType: 'Lot',
    severity: 'BLOCK', ownerDepartment: 'OPERATIONS', checkMode: 'REALTIME',
    description: 'A lot needs a grade, a net weight, an expiry time and a storage unit before it goes into cold storage.',
  },
  {
    code: 'DQ-03', name: 'Valid contact & TIN format', dimension: 'VALIDITY', entityType: 'Fisher,Buyer',
    severity: 'BLOCK', ownerDepartment: 'ADMIN', checkMode: 'REALTIME',
    description: 'Phone must be 09XXXXXXXXX, TIN must be XXX-XXX-XXX-XXX, email must be a valid address.',
  },
  {
    code: 'DQ-04', name: 'Plausible temperature reading', dimension: 'VALIDITY', entityType: 'TemperatureLog',
    severity: 'WARN', ownerDepartment: 'OPERATIONS', checkMode: 'REALTIME', params: { minC: -40, maxC: 15 },
    description: 'A reading outside the physically possible range is probably a sensor or encoding error.',
  },
  {
    code: 'DQ-05', name: 'Net weight ≤ gross weight', dimension: 'ACCURACY', entityType: 'LandingItem',
    severity: 'BLOCK', ownerDepartment: 'OPERATIONS', checkMode: 'REALTIME',
    description: 'The total net weight of all lots graded from a catch cannot exceed the gross weight received at the port.',
  },
  {
    code: 'DQ-06', name: 'Selling price within range', dimension: 'ACCURACY', entityType: 'SalesOrderItem',
    severity: 'WARN', ownerDepartment: 'SALES', checkMode: 'REALTIME',
    description: "The selling price per kg must be within the species' minimum and maximum price.",
  },
  {
    code: 'DQ-07', name: 'Catch within vessel capacity', dimension: 'ACCURACY', entityType: 'Landing',
    severity: 'WARN', ownerDepartment: 'OPERATIONS', checkMode: 'REALTIME',
    description: "The total landed weight should not exceed the vessel's registered capacity.",
  },
  {
    code: 'DQ-08', name: 'No duplicate fishers / buyers', dimension: 'UNIQUENESS', entityType: 'Fisher,Buyer',
    severity: 'WARN', ownerDepartment: 'ADMIN', checkMode: 'REALTIME', params: { threshold: 0.6 },
    description: 'Flags records with a very similar name (trigram similarity) or the same phone number as another record.',
  },
  {
    code: 'DQ-09', name: 'No over-selling of a lot', dimension: 'UNIQUENESS', entityType: 'Lot',
    severity: 'BLOCK', ownerDepartment: 'SALES', checkMode: 'REALTIME',
    description: 'Each kilogram can be sold only once: reserved weight cannot exceed the available weight of the lot.',
  },
  {
    code: 'DQ-10', name: 'Shrinkage within tolerance', dimension: 'CONSISTENCY', entityType: 'DispatchItem',
    severity: 'WARN', ownerDepartment: 'OPERATIONS', checkMode: 'EVENT',
    description: "Weight lost between storage and delivery must be within the species' shrinkage tolerance.",
  },
  {
    code: 'DQ-11', name: 'Invoice total matches items', dimension: 'CONSISTENCY', entityType: 'Invoice',
    severity: 'BLOCK', ownerDepartment: 'FINANCE', checkMode: 'REALTIME',
    description: 'The invoice total must equal the sum of its line items.',
  },
  {
    code: 'DQ-12', name: 'Storage temperature in range', dimension: 'CONSISTENCY', entityType: 'StorageUnit',
    severity: 'WARN', ownerDepartment: 'OPERATIONS', checkMode: 'REALTIME',
    description: "The latest temperature of a storage unit must be within the unit's required range.",
  },
  {
    code: 'DQ-13', name: 'No expired lots for sale', dimension: 'TIMELINESS', entityType: 'Lot',
    severity: 'BLOCK', ownerDepartment: 'OPERATIONS', checkMode: 'BATCH',
    description: 'A lot past its freshness limit is quarantined automatically and cannot be stored or sold.',
  },
  {
    code: 'DQ-14', name: 'Temperature logged regularly', dimension: 'TIMELINESS', entityType: 'StorageUnit',
    severity: 'WARN', ownerDepartment: 'OPERATIONS', checkMode: 'BATCH', params: { hours: 4 },
    description: 'Every storage unit must have a temperature reading within the last few hours.',
  },
  {
    code: 'DQ-15', name: 'Landings graded promptly', dimension: 'TIMELINESS', entityType: 'Landing',
    severity: 'WARN', ownerDepartment: 'OPERATIONS', checkMode: 'BATCH', params: { hours: 2 },
    description: 'A landing should be graded by QC within a few hours of arrival.',
  },
];
