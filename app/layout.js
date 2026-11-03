export const metadata = {
  title: 'くさコイン | みんなの架空マーケット',
  description: '架空コインを売り買いするオンラインゲーム',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}