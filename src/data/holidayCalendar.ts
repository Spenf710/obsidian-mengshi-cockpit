// ===== 中国法定节假日 / 调休补班日历 =====
// 数据源：国务院办公厅每年发布的放假安排（本文件内置 2026 全年数据）
// 数据口径与 https://timor.tech/api/holiday/year/2026 一致，可在每年 11~12 月更新次年数据
// isHoliday=true  → 法定休假日（如春节/国庆）
// isHoliday=false → 调休补班上班日（如「端午节前补班」周末上班）

export interface HolidayDay {
  /** 节日名（如「春节」「中秋节前补班」） */
  name: string;
  /** true=法定休假日，false=调休补班上班日 */
  isHoliday: boolean;
}

const HOLIDAYS: Record<string, Record<string, HolidayDay>> = {
  '2026': {
    '01-01': { name: '元旦', isHoliday: true },
    '01-02': { name: '元旦', isHoliday: true },
    '01-03': { name: '元旦', isHoliday: true },
    '01-04': { name: '元旦后补班', isHoliday: false },
    '02-14': { name: '春节前补班', isHoliday: false },
    '02-15': { name: '春节', isHoliday: true },
    '02-16': { name: '除夕', isHoliday: true },
    '02-17': { name: '初一', isHoliday: true },
    '02-18': { name: '初二', isHoliday: true },
    '02-19': { name: '初三', isHoliday: true },
    '02-20': { name: '初四', isHoliday: true },
    '02-21': { name: '初五', isHoliday: true },
    '02-22': { name: '初六', isHoliday: true },
    '02-23': { name: '初七', isHoliday: true },
    '02-28': { name: '春节后补班', isHoliday: false },
    '04-04': { name: '清明节', isHoliday: true },
    '04-05': { name: '清明节', isHoliday: true },
    '04-06': { name: '清明节', isHoliday: true },
    '05-01': { name: '劳动节', isHoliday: true },
    '05-02': { name: '劳动节', isHoliday: true },
    '05-03': { name: '劳动节', isHoliday: true },
    '05-04': { name: '劳动节', isHoliday: true },
    '05-05': { name: '劳动节', isHoliday: true },
    '05-09': { name: '劳动节后补班', isHoliday: false },
    '06-19': { name: '端午节', isHoliday: true },
    '06-20': { name: '端午节', isHoliday: true },
    '06-21': { name: '端午节', isHoliday: true },
    '09-20': { name: '中秋节前补班', isHoliday: false },
    '09-25': { name: '中秋节', isHoliday: true },
    '09-26': { name: '中秋节', isHoliday: true },
    '09-27': { name: '中秋节', isHoliday: true },
    '10-01': { name: '国庆节', isHoliday: true },
    '10-02': { name: '国庆节', isHoliday: true },
    '10-03': { name: '国庆节', isHoliday: true },
    '10-04': { name: '国庆节', isHoliday: true },
    '10-05': { name: '国庆节', isHoliday: true },
    '10-06': { name: '国庆节', isHoliday: true },
    '10-07': { name: '国庆节', isHoliday: true },
    '10-10': { name: '国庆节后补班', isHoliday: false },
  },
};

/** 查询某天是否是节假日/补班日（dateStr: YYYY-MM-DD） */
export function getHoliday(dateStr: string): HolidayDay | null {
  const sep = dateStr.indexOf('-');
  if (sep < 0) return null;
  const y = dateStr.slice(0, sep);
  const md = dateStr.slice(sep + 1);
  return HOLIDAYS[y]?.[md] ?? null;
}

/** 当年是否已有内置放假数据（用于提示） */
export function hasHolidayData(year: number): boolean {
  return !!HOLIDAYS[String(year)];
}