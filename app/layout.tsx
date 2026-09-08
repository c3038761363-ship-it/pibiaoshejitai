import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '皮牌设计台',
  description: '按实际毫米尺寸制作服装皮牌矢量图。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
