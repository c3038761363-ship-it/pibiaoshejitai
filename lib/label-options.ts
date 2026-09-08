import type { MarkLayout, MarkShape } from '@/lib/leather-label-svg';

export type SizeOption = {
  label: string;
  width: number;
  height: number;
};

export type FontOption = {
  id: string;
  label: string;
  group: string;
  stack: string;
  caution?: boolean;
};

export type DesignTemplate = {
  id: string;
  name: string;
  category: string;
  mainText: string;
  subText: string;
  mainFont: string;
  subFont: string;
  markShape: MarkShape;
  markText: string;
  markLayout: MarkLayout;
  fontSize: number;
};

export const SIZE_OPTIONS: SizeOption[] = [
  { label: '80 × 50 mm', width: 80, height: 50 },
  { label: '80 × 55 mm', width: 80, height: 55 },
  { label: '60 × 50 mm', width: 60, height: 50 },
  { label: '80 × 60 mm', width: 80, height: 60 },
];

export const CATEGORIES = ['商务装', '女装', '男装', '童装'];
export const LABEL_TYPES = ['大款皮牌', '小款皮牌', '后袋饰品皮牌'];

export const FONT_OPTIONS: FontOption[] = [
  {
    id: 'microsoft-yahei',
    label: '微软雅黑',
    group: '中文现代',
    stack: '"Microsoft YaHei", "微软雅黑", sans-serif',
  },
  {
    id: 'simhei',
    label: '黑体',
    group: '中文现代',
    stack: 'SimHei, "黑体", sans-serif',
  },
  {
    id: 'dengxian',
    label: '等线',
    group: '中文现代',
    stack: 'DengXian, "等线", sans-serif',
  },
  {
    id: 'youyuan',
    label: '幼圆',
    group: '中文圆润',
    stack: 'YouYuan, "幼圆", sans-serif',
  },
  {
    id: 'simsun',
    label: '宋体',
    group: '中文衬线',
    stack: 'SimSun, "宋体", serif',
    caution: true,
  },
  {
    id: 'stsong',
    label: '华文宋体',
    group: '中文衬线',
    stack: 'STSong, "华文宋体", SimSun, serif',
    caution: true,
  },
  {
    id: 'kaiti',
    label: '楷体',
    group: '中文书写',
    stack: 'KaiTi, "楷体", serif',
    caution: true,
  },
  {
    id: 'fangsong',
    label: '仿宋',
    group: '中文书写',
    stack: 'FangSong, "仿宋", serif',
    caution: true,
  },
  {
    id: 'arial',
    label: 'Arial',
    group: '英文简洁',
    stack: 'Arial, sans-serif',
  },
  {
    id: 'arial-black',
    label: 'Arial Black',
    group: '英文粗体',
    stack: '"Arial Black", Arial, sans-serif',
  },
  {
    id: 'impact',
    label: 'Impact',
    group: '英文高窄',
    stack: 'Impact, sans-serif',
  },
  {
    id: 'trebuchet',
    label: 'Trebuchet MS',
    group: '英文圆润',
    stack: '"Trebuchet MS", sans-serif',
  },
  {
    id: 'verdana',
    label: 'Verdana',
    group: '英文简洁',
    stack: 'Verdana, sans-serif',
  },
  {
    id: 'georgia',
    label: 'Georgia',
    group: '英文衬线',
    stack: 'Georgia, serif',
    caution: true,
  },
  {
    id: 'times',
    label: 'Times New Roman',
    group: '英文衬线',
    stack: '"Times New Roman", serif',
    caution: true,
  },
  {
    id: 'cambria',
    label: 'Cambria',
    group: '英文衬线',
    stack: 'Cambria, serif',
    caution: true,
  },
  {
    id: 'courier',
    label: 'Courier New',
    group: '英文等宽',
    stack: '"Courier New", monospace',
  },
  {
    id: 'consolas',
    label: 'Consolas',
    group: '英文等宽',
    stack: 'Consolas, monospace',
  },
];

export const SHAPE_OPTIONS: { value: MarkShape; label: string }[] = [
  { value: 'none', label: '不使用' },
  { value: 'circle', label: '圆形' },
  { value: 'oval', label: '椭圆' },
  { value: 'diamond', label: '菱形' },
  { value: 'hexagon', label: '六边形' },
  { value: 'shield', label: '盾牌' },
  { value: 'star', label: '星形' },
];

export const LAYOUT_OPTIONS: { value: MarkLayout; label: string }[] = [
  { value: 'badge', label: '字母徽章' },
  { value: 'left', label: '左图右字' },
  { value: 'top', label: '上图下字' },
];

export const DESIGN_TEMPLATES: DesignTemplate[] = [
  {
    id: 'voyager',
    name: '远行者',
    category: '商务装',
    mainText: '远行者',
    subText: 'VOYAGER · 1998',
    mainFont: 'kaiti',
    subFont: 'georgia',
    markShape: 'diamond',
    markText: '远',
    markLayout: 'left',
    fontSize: 8.5,
  },
  {
    id: 'kapok',
    name: '木棉',
    category: '女装',
    mainText: '木棉',
    subText: 'KAPOK STUDIO',
    mainFont: 'stsong',
    subFont: 'times',
    markShape: 'circle',
    markText: '木',
    markLayout: 'top',
    fontSize: 9,
  },
  {
    id: 'urban',
    name: '城野',
    category: '男装',
    mainText: '城野',
    subText: 'URBAN FIELD',
    mainFont: 'dengxian',
    subFont: 'impact',
    markShape: 'shield',
    markText: 'CY',
    markLayout: 'left',
    fontSize: 8.5,
  },
  {
    id: 'elephant',
    name: '小象',
    category: '童装',
    mainText: '小象',
    subText: 'LITTLE ELEPHANT',
    mainFont: 'youyuan',
    subFont: 'trebuchet',
    markShape: 'star',
    markText: 'LE',
    markLayout: 'top',
    fontSize: 9,
  },
  {
    id: 'atelier',
    name: '原创工坊',
    category: '女装',
    mainText: 'ATELIER',
    subText: '原创工坊',
    mainFont: 'georgia',
    subFont: 'microsoft-yahei',
    markShape: 'oval',
    markText: 'A',
    markLayout: 'badge',
    fontSize: 8,
  },
  {
    id: 'qinghe',
    name: '青禾',
    category: '商务装',
    mainText: '青禾 QINGHE',
    subText: '自然质感 · ORIGINAL',
    mainFont: 'microsoft-yahei',
    subFont: 'arial',
    markShape: 'hexagon',
    markText: 'QH',
    markLayout: 'top',
    fontSize: 7.5,
  },
  {
    id: 'north',
    name: '北境',
    category: '男装',
    mainText: 'NORTHBOUND',
    subText: '北境 · EST. 1998',
    mainFont: 'arial-black',
    subFont: 'simsun',
    markShape: 'shield',
    markText: 'NB',
    markLayout: 'left',
    fontSize: 7.5,
  },
  {
    id: 'kids-club',
    name: '快乐童装',
    category: '童装',
    mainText: 'KIDS CLUB',
    subText: '快乐成长每一天',
    mainFont: 'trebuchet',
    subFont: 'youyuan',
    markShape: 'circle',
    markText: 'K',
    markLayout: 'badge',
    fontSize: 8.5,
  },
];

export const LEATHER_COLORS = [
  { name: '黑色', value: '#20201f' },
  { name: '深棕', value: '#563522' },
  { name: '驼色', value: '#a16f43' },
  { name: '浅棕', value: '#c49262' },
];

export const STAMP_COLORS = [
  { name: '黑色', value: '#111111' },
  { name: '金色', value: '#d8b66f' },
  { name: '银色', value: '#d8dadd' },
  { name: '白色', value: '#f4f1e9' },
];

export function getFont(id: string) {
  return FONT_OPTIONS.find((font) => font.id === id) ?? FONT_OPTIONS[0];
}
