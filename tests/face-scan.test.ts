import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { app, makeUser, tokenFor } from './helpers';
import { deviceEmpNo } from '../src/modules/attendance/routes';

const sfx = Date.now().toString(36);
let A: string;
let rec = '';
let key = '';
let memberId = '';
const h = () => ({ Authorization: `Bearer ${rec}`, 'X-Branch-Id': A });
const scan = (no: string) =>
  request(app).post(`/api/public/attendance/hikvision/${key}`).send({ dateTime: new Date().toISOString(), AccessControllerEvent: { employeeNoString: no } });

beforeAll(async () => {
  const code = `fs${sfx}`;
  A = (await prisma.branch.create({ data: { code, name: 'FS' } })).id;
  await makeUser(`rec@${code}.test`, 'receptionist', code);
  rec = await tokenFor(`rec@${code}.test`);
  const owner = await makeUser(`own@${code}.test`, 'owner', null);
  void owner;
  const own = await tokenFor(`own@${code}.test`);
  const dev = await request(app).post('/api/attendance/devices').set({ Authorization: `Bearer ${own}`, 'X-Branch-Id': A }).send({ name: 'FS dev', branch_id: A });
  key = dev.body.data.device_key;
  const m = await prisma.member.create({ data: { code: `HV${sfx}`, name: 'Khach Quet', phone: `07${sfx.replace(/\D/g, '').padEnd(8, '3').slice(0, 8)}`, branchId: A, faceId: `FACE${sfx}` } });
  memberId = m.id;
});

describe('face scan popup feed', () => {
  it('matches a member by face id and reports state and debt', async () => {
    const pkg = await prisma.package.create({ data: { name: `FS ${sfx}`, type: 'month', durationDays: 30, price: 1000, branchId: A } });
    await prisma.contract.create({
      data: { code: `CF${sfx}`, memberId, packageId: pkg.id, branchId: A, status: 'active', totalAmount: 1000, paidAmount: 400, endDate: new Date(Date.now() + 10 * 86400000) },
    });
    const since = new Date(Date.now() - 1000).toISOString();
    expect((await scan(`FACE${sfx}`)).status).toBe(200);
    const r = await request(app).get('/api/attendance/scans').query({ since }).set(h());
    expect(r.status).toBe(200);
    const it0 = r.body.data.items.find((x: { employee_no: string }) => x.employee_no === `FACE${sfx}`);
    expect(it0.member.name).toBe('Khach Quet');
    expect(it0.member.state).toBe('ok');
    expect(it0.member.debt).toBe(600);
    expect(it0.result).toBe('allowed');
    expect(await prisma.checkin.count({ where: { memberId, result: 'allowed' } })).toBe(1);
  });

  it('records a denied result when the member has no usable package', async () => {
    const m2 = await prisma.member.create({ data: { code: `HVN${sfx}`, name: 'Khach Khong Goi', phone: `05${sfx.replace(/\D/g, '').padEnd(8, '4').slice(0, 8)}`, branchId: A } });
    const since = new Date(Date.now() - 1000).toISOString();
    await scan(`HVN${sfx}`);
    const r = await request(app).get('/api/attendance/scans').query({ since }).set(h());
    const it0 = r.body.data.items.find((x: { employee_no: string }) => x.employee_no === `HVN${sfx}`);
    expect(it0.result).toBe('denied');
    expect(it0.reason).toBe('NO_ACTIVE_CONTRACT');
    expect(await prisma.checkin.count({ where: { memberId: m2.id, result: 'allowed' } })).toBe(0);
  });

  it('reports an unknown code and ignores a repeat within 10 seconds', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    await scan('99887');
    await scan('99887');
    const r = await request(app).get('/api/attendance/scans').query({ since }).set(h());
    const rows = r.body.data.items.filter((x: { employee_no: string }) => x.employee_no === '99887');
    expect(rows).toHaveLength(1);
    expect(rows[0].member).toBeNull();
  });
});

describe('face enrollment queue', () => {
  it('needs consent and a photo, then the bridge claims and finishes the job', async () => {
    expect((await request(app).post('/api/attendance/face-jobs').set(h()).send({ member_id: memberId })).status).toBe(400);
    const noPhoto = await request(app).post('/api/attendance/face-jobs').set(h()).send({ member_id: memberId, consent: true });
    expect(noPhoto.status).toBe(409);
    await prisma.memberPhoto.create({ data: { memberId, contentType: 'image/jpeg', data: Buffer.from('jpegbytes') } });
    const ok = await request(app).post('/api/attendance/face-jobs').set(h()).send({ member_id: memberId, consent: true });
    expect(ok.status).toBe(201);

    const claim = await request(app).get(`/api/public/attendance/jobs/${key}`);
    expect(claim.status).toBe(200);
    expect(claim.body.data).toHaveLength(1);
    expect(claim.body.data[0].employee_no).toBe(deviceEmpNo(`HV${sfx}`, `FACE${sfx}`));
    expect(Buffer.from(claim.body.data[0].photo, 'base64').toString()).toBe('jpegbytes');
    expect((await request(app).get(`/api/public/attendance/jobs/${key}`)).body.data).toHaveLength(0);

    const done = await request(app).post(`/api/public/attendance/jobs/${key}/done`).send({ id: claim.body.data[0].id, ok: true, message: 'Da dang ky' });
    expect(done.status).toBe(200);
    const list = await request(app).get('/api/attendance/face-jobs').query({ member_id: memberId }).set(h());
    expect(list.body.data[0].status).toBe('done');
  });

  it('rejects an unknown device key', async () => {
    expect((await request(app).get('/api/public/attendance/jobs/nope')).status).toBe(404);
  });
});

describe('pull face photos from the device', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString('base64');
  it('saves a photo only for a matching member without one, never overwrites', async () => {
    const code = `HVP${sfx}`;
    const m = await prisma.member.create({ data: { code, name: 'Khach Anh', phone: `06${sfx.replace(/\D/g, '').padEnd(8, '5').slice(0, 8)}`, branchId: A } });
    const url = `/api/public/attendance/facepush/${key}`;
    expect((await request(app).post(url).send({ employee_no: 'ZZ-none', photo: jpeg })).body.data.result).toBe('no_match');
    expect((await request(app).post(url).send({ employee_no: code })).body.data.result).toBe('no_photo');
    expect((await request(app).post(url).send({ employee_no: code, photo: 'AAAA' })).body.data.result).toBe('bad_image');
    expect((await request(app).post(url).send({ employee_no: code, photo: jpeg })).body.data.result).toBe('saved');
    expect(await prisma.memberPhoto.count({ where: { memberId: m.id } })).toBe(1);
    expect((await request(app).post(url).send({ employee_no: code, photo: jpeg })).body.data.result).toBe('has_photo');
  });
});


describe('device employee numbers for DemoGym enrollments', () => {
  it('maps member codes to the 8xxxxxx range and back', async () => {
    expect(deviceEmpNo('HV1453', null)).toBe('8001453');
    expect(deviceEmpNo('HV0389', 'X')).toBe('8000389');
    expect(deviceEmpNo('GH1000', null)).toBe('9001000');
    expect(deviceEmpNo('ABC', 'FACE9')).toBe('FACE9');
    const code = `HV${6000 + (Date.now() % 900)}`;
    const m = await prisma.member.create({ data: { code, name: 'Khach Dai 8', phone: `04${sfx.replace(/\D/g, '').padEnd(8, '6').slice(0, 8)}`, branchId: A } });
    const since = new Date(Date.now() - 1000).toISOString();
    await scan(deviceEmpNo(code, null));
    const r = await request(app).get('/api/attendance/scans').query({ since }).set(h());
    const it0 = r.body.data.items.find((x: { employee_no: string }) => x.employee_no === deviceEmpNo(code, null));
    expect(it0.member.id).toBe(m.id);
  });
});

describe('enrolling a member with a non-HV code', () => {
  it('assigns a 9xxxxxx device number, stores it as face id, and scans resolve to that member', async () => {
    const n = 2000 + (Date.now() % 700);
    const code = `GH${n}`;
    const m = await prisma.member.create({ data: { code, name: 'Khach GH', phone: `03${sfx.replace(/\D/g, '').padEnd(8, '7').slice(0, 8)}`, branchId: A } });
    await prisma.memberPhoto.create({ data: { memberId: m.id, contentType: 'image/jpeg', data: Buffer.from('jpegbytes') } });
    const r = await request(app).post('/api/attendance/face-jobs').set(h()).send({ member_id: m.id, consent: true });
    expect(r.status).toBe(201);
    const emp = `9${String(n).padStart(6, '0')}`;
    expect((await prisma.member.findUniqueOrThrow({ where: { id: m.id } })).faceId).toBe(emp);
    const claim = await request(app).get(`/api/public/attendance/jobs/${key}`);
    expect(claim.body.data.find((j: { employee_no: string }) => j.employee_no === emp)).toBeTruthy();
    const since = new Date(Date.now() - 1000).toISOString();
    await scan(emp);
    const sc = await request(app).get('/api/attendance/scans').query({ since }).set(h());
    expect(sc.body.data.items.find((x: { employee_no: string }) => x.employee_no === emp).member.id).toBe(m.id);
  });
});

