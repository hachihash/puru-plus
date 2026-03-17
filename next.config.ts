/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // !! 警告 !!
    // プロジェクトにタイプエラーがあっても、本番ビルドを正常に完了させます。
    ignoreBuildErrors: true,
  },
  eslint: {
    // ビルド時のESLintエラーも無視するようにします
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;