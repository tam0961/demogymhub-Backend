import { config } from '../../config';
import { fmtDate } from '../../lib/dates';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';

export const bookingOutbox: { to: string; subject: string; html: string }[] = [];

interface Line { date: string; start: string; end: string; muscle_group: string | null }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

async function deliver(to: string, subject: string, html: string) {
  if (config.APP_ENV === 'test') bookingOutbox.push({ to, subject, html });
  if (!config.MAIL_API_KEY || !config.MAIL_FROM) {
    logger.info({ to, subject }, 'booking mail skipped: MAIL_API_KEY or MAIL_FROM not set');
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.MAIL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.MAIL_FROM, to: [to], subject, html }),
  });
  if (!r.ok) logger.warn({ to, status: r.status }, 'booking mail failed');
}

export async function sendBookingMails(member: { id: string; name: string; phone: string; email: string | null }, lines: Line[]) {
  try {
    const contracts = await prisma.contract.findMany({
      where: { memberId: member.id, status: 'active', package: { category: 'pt_group' } },
      select: { sessionsLeft: true, endDate: true },
    });
    const remain = contracts.reduce((t, c) => t + (c.sessionsLeft ?? 0), 0);
    const end = contracts.map((c) => c.endDate).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
    const list = lines.map((l) => `<li>${dmy(l.date)} ${l.start}-${l.end}${l.muscle_group ? ` (${esc(l.muscle_group)})` : ''}</li>`).join('');
    const jobs: Promise<void>[] = [];
    if (config.BOOKING_ADMIN_EMAIL) {
      jobs.push(deliver(config.BOOKING_ADMIN_EMAIL, `Đăng ký mới: ${member.name}`, `<p><b>Thông tin học viên:</b></p><ul><li>Họ tên: ${esc(member.name)}</li><li>SĐT: ${esc(member.phone)}</li><li>Email: ${esc(member.email ?? '')}</li></ul><p><b>Các lớp đã đăng ký:</b></p><ul>${list}</ul>`));
    }
    if (member.email) {
      const endText = end ? `<p><b>Ngày kết thúc gói tập:</b> ${dmy(fmtDate(end)!)}</p>` : '';
      jobs.push(deliver(member.email, 'Xác nhận đăng ký lớp - TH Gym', `<p>Chào ${esc(member.name)},</p><p>Bạn đã đăng ký thành công:</p><ul>${list}</ul><p><b>Số buổi còn lại:</b> ${remain}</p>${endText}<p>Hẹn gặp bạn tại TH Gym</p>`));
    }
    await Promise.all(jobs);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'booking mail error');
  }
}
