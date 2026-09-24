class Arelay < Formula
  desc "Run OpenAI subagents in Claude Code and Claude subagents in Codex"
  homepage "https://github.com/wrsrsh/arelay"
  url "https://github.com/wrsrsh/arelay/releases/download/v0.1.0/arelay.tar.gz"
  version "0.1.0"
  sha256 "5921ff5d3bd4b7341be85cf68fd99a7ef85d8fdac9e561d93f238d34a43266e9"
  license all_of: ["MIT", "Apache-2.0", "BSD-3-Clause"]

  depends_on "node"

  def install
    libexec.install "arelay.mjs"
    libexec.install "LICENSE", "LICENSE.openai-codex", "THIRD_PARTY_NOTICES.md"
    bin.install_symlink libexec/"arelay.mjs" => "arelay"
  end

  def caveats
    <<~EOS
      arelay manages its own login service (not brew services).
      Config: ~/.config/arelay/config.json
      Add API credentials, then run: arelay setup claude|codex|both
      Before uninstalling: arelay unsetup both && arelay service uninstall
      Start and enable the login service: arelay install
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/arelay --version").strip
    assert_match "cross-provider subagents", shell_output("#{bin}/arelay --help")
  end
end
