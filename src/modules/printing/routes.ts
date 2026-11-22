import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middlewares/auth';

const KEY = 'print_templates';
export const TEMPLATE_KEYS = ['contract_member', 'contract_pt', 'contract_deposit', 'freeze_form', 'transfer_form', 'receipt'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
type Tpl = { title: string; body: string };

const HEAD = 'TH GYM & FITNESS - {{chi_nhanh}}';
const PARTIES = 'Hội viên: {{ten_hoi_vien}} (Mã: {{ma_hoi_vien}}) - SĐT: {{sdt}}';
const MONEY = 'Tổng giá trị: {{tong_tien}}\nĐã thanh toán: {{da_thanh_toan}}\nCòn thiếu: {{con_thieu}}';
const SIGN = 'Hội viên ký tên                                   Nhân viên tư vấn: {{nhan_vien_sale}}';

export const DEFAULTS: Record<TemplateKey, Tpl> = {
  contract_member: {
    title: 'HỢP ĐỒNG HỘI VIÊN',
    body: `${HEAD}\n\nSố hợp đồng: {{ma_hop_dong}}      Ngày lập: {{ngay_in}}\n${PARTIES}\n\nGói tập: {{goi_tap}}\nHiệu lực: {{ngay_bat_dau}} đến {{ngay_het_han}}\n${MONEY}\n\nĐiều khoản:\n1. Hội viên tuân thủ nội quy phòng tập và hướng dẫn của nhân viên.\n2. Gói tập không hoàn tiền và không chuyển nhượng trừ khi có phiếu chuyển nhượng được duyệt.\n3. Hội viên có thể bảo lưu theo phiếu bảo lưu được duyệt.\n\n${SIGN}`,
  },
  contract_pt: {
    title: 'HỢP ĐỒNG HUẤN LUYỆN CÁ NHÂN (PT)',
    body: `${HEAD}\n\nSố hợp đồng: {{ma_hop_dong}}      Ngày lập: {{ngay_in}}\n${PARTIES}\n\nGói PT: {{goi_tap}}\nHuấn luyện viên phụ trách: {{pt_phu_trach}}\nHiệu lực: {{ngay_bat_dau}} đến {{ngay_het_han}}\n${MONEY}\n\nĐiều khoản:\n1. Hội viên đặt lịch trước và đến đúng giờ; hủy lịch chậm hoặc vắng mặt vẫn bị trừ buổi.\n2. Buổi tập chưa dùng hết sau hạn sử dụng gói PT sẽ không được bảo lưu.\n3. Gói PT cần kèm gói member còn hiệu lực để vào phòng tập.\n\n${SIGN}`,
  },
  contract_deposit: {
    title: 'HỢP ĐỒNG ĐẶT CỌC',
    body: `${HEAD}\n\nSố hợp đồng: {{ma_hop_dong}}      Ngày lập: {{ngay_in}}\n${PARTIES}\n\nGói đăng ký: {{goi_tap}}\nSố tiền đã cọc: {{da_thanh_toan}} / {{tong_tien}} (còn thiếu {{con_thieu}})\n\nĐiều khoản:\n1. Đây là hợp đồng đặt cọc, hội viên chưa được vào tập cho đến khi thanh toán đủ phần giá trị quy định.\n2. Khi thanh toán đủ, hợp đồng chuyển thành hợp đồng gói tập và hội viên ký lại.\n3. Tiền cọc không hoàn lại nếu hội viên không tiếp tục đăng ký.\n\n${SIGN}`,
  },
  freeze_form: {
    title: 'PHIẾU BẢO LƯU HỢP ĐỒNG',
    body: `${HEAD}\n\nNgày lập: {{ngay_in}}\n${PARTIES}\n\nHợp đồng: {{ma_hop_dong}} - {{goi_tap}}\nHiệu lực hiện tại: {{ngay_bat_dau}} đến {{ngay_het_han}}\nSố ngày bảo lưu: {{so_ngay_bao_luu}}\nLý do: {{ly_do}}\n\nSau thời gian bảo lưu, hợp đồng tự động hoạt động trở lại và ngày hết hạn được cộng thêm số ngày đã bảo lưu.\n\n${SIGN}`,
  },
  receipt: {
    title: 'PHIẾU THU',
    body: `${HEAD}

Mã phiếu thu: {{ma_phieu_thu}}      Ngày thu: {{ngay_thu}}
Hội viên: {{ten_hoi_vien}} (Mã: {{ma_hoi_vien}}) - SĐT: {{sdt}}

Hợp đồng: {{ma_hop_dong}} - {{goi_tap}}
Số tiền thu: {{so_tien}}
Hình thức: {{hinh_thuc}}
Còn thiếu sau phiếu này: {{con_thieu}}

Nhân viên thu: {{nhan_vien_thu}}\n\nNgười nộp tiền ký tên`,
  },
  transfer_form: {
    title: 'PHIẾU CHUYỂN NHƯỢNG HỢP ĐỒNG',
    body: `${HEAD}\n\nNgày lập: {{ngay_in}}\nNgười chuyển nhượng: {{ten_hoi_vien}} (Mã: {{ma_hoi_vien}}) - SĐT: {{sdt}}\nNgười nhận: {{nguoi_nhan}} - SĐT: {{sdt_nguoi_nhan}}\n\nHợp đồng: {{ma_hop_dong}} - {{goi_tap}}\nThời hạn còn lại: đến {{ngay_het_han}}\nPhí chuyển nhượng: {{phi_chuyen_nhuong}}\n\nHai bên đã đọc và đồng ý với nội dung trên. Từ ngày lập phiếu, người nhận được hưởng toàn bộ quyền lợi còn lại của hợp đồng.\n\nNgười chuyển nhượng ký                         Người nhận ký`,
  },
};

const tplSchema = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(20000) });
const stored = z.record(z.string(), tplSchema);

async function getStored(): Promise<Record<string, Tpl>> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  const p = stored.safeParse(row?.value);
  return p.success ? p.data : {};
}
const save = (value: Record<string, Tpl>) => prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
const keyOf = (v: unknown) => z.enum(TEMPLATE_KEYS).parse(v);

export const printRouter = Router();
printRouter.use(authenticate);

printRouter.get('/', authorize('contracts.read'), async (_req, res) => {
  const s = await getStored();
  res.json({ data: TEMPLATE_KEYS.map((k) => ({ key: k, ...(s[k] ?? DEFAULTS[k]), is_default: !s[k] })) });
});

printRouter.put('/:key', authorize('system.manage_settings'), async (req, res) => {
  const key = keyOf(req.params.key);
  const b = tplSchema.parse(req.body);
  await save({ ...(await getStored()), [key]: b });
  await audit(req.auth!.userId, 'print_template.updated', { key }, req.ip);
  res.json({ data: { key, ...b, is_default: false } });
});

printRouter.delete('/:key', authorize('system.manage_settings'), async (req, res) => {
  const key = keyOf(req.params.key);
  const { [key]: _drop, ...rest } = await getStored();
  await save(rest);
  await audit(req.auth!.userId, 'print_template.reset', { key }, req.ip);
  res.json({ data: { key, ...DEFAULTS[key], is_default: true } });
});
