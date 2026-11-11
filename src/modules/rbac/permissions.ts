const CRUD = ['create', 'read', 'update', 'delete'];

const expand = (resource: string, actions: string[]) => actions.map((a) => `${resource}.${a}`);

export const PERMISSIONS: string[] = [
  ...expand('members', CRUD),
  ...expand('packages', ['create', 'read', 'update']),
  ...expand('leads', CRUD),
  ...expand('contracts', ['create', 'read', 'sign', 'approve', 'cancel', 'override_checkin', 'activate', 'freeze']),
  ...expand('payments', ['create', 'read', 'refund', 'refund_request', 'pay_own', 'confirm']),
  ...expand('debt', ['write_off']),
  ...expand('shifts', ['open', 'close']),
  ...expand('checkins', ['create', 'read', 'override']),
  ...expand('pt_sessions', ['read', 'complete']),
  ...expand('classes', ['attendance']),
  ...expand('bookings', ['create']),
  ...expand('reports', ['view', 'view_revenue', 'export']),
  ...expand('roles', ['read', 'assign']),
  ...expand('system', ['view_audit_log', 'manage_settings']),
  'me.read',
];

const OPS = [
  'contracts.read',
  'contracts.create',
  'contracts.sign',
  'contracts.activate',
  'contracts.freeze',
  'contracts.approve',
  'contracts.cancel',
  'contracts.override_checkin',
  'payments.read',
  'payments.create',
  'payments.confirm',
  'payments.refund_request',
  'shifts.open',
  'shifts.close',
  'checkins.read',
  'checkins.create',
  'checkins.override',
];

const VIEW_ONLY_REMOVED = ['contracts.override_checkin', 'checkins.create', 'checkins.override'];
const OWNER_OPS = OPS.filter((p) => !VIEW_ONLY_REMOVED.includes(p));

export interface RoleDef {
  key: string;
  name: string;
  global: boolean;
  permissions: string[];
}

export const ROLES: RoleDef[] = [
  { key: 'super_admin', name: 'Super Admin', global: true, permissions: PERMISSIONS },
  {
    key: 'owner',
    name: 'Owner',
    global: true,
    permissions: [
      ...expand('members', CRUD),
      ...expand('packages', ['create', 'read', 'update']),
      ...expand('reports', ['view', 'view_revenue', 'export']),
      ...OWNER_OPS,
      'payments.refund',
      'roles.read',
      'roles.assign',
      'system.view_audit_log',
      'system.manage_settings',
      'me.read',
    ],
  },
  {
    key: 'branch_manager',
    name: 'Branch Manager',
    global: false,
    permissions: [
      ...expand('members', CRUD),
      ...expand('packages', ['create', 'read', 'update']),
      ...OPS,
      'reports.view',
      'me.read',
    ],
  },
  {
    key: 'receptionist',
    name: 'Receptionist',
    global: false,
    permissions: [
      'members.create',
      'members.read',
      'members.update',
      'packages.read',
      'contracts.create',
      'contracts.read',
      'contracts.sign',
      'contracts.activate',
      'payments.create',
      'payments.read',
      'checkins.create',
      'checkins.read',
      'shifts.open',
      'shifts.close',
      'me.read',
    ],
  },
  {
    key: 'sales',
    name: 'Sales',
    global: false,
    permissions: [...expand('leads', CRUD), 'members.create', 'members.read', 'packages.read', 'contracts.create', 'contracts.read', 'me.read'],
  },
  {
    key: 'trainer',
    name: 'Trainer',
    global: false,
    permissions: ['pt_sessions.read', 'pt_sessions.complete', 'classes.attendance', 'me.read'],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    global: true,
    permissions: ['payments.read', 'contracts.read', 'reports.view_revenue', 'reports.export', 'members.read', 'packages.read', 'me.read'],
  },
  {
    key: 'member',
    name: 'Member',
    global: false,
    permissions: ['me.read', 'bookings.create', 'payments.pay_own', 'packages.read'],
  },
];
