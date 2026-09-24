class Arelay < Formula
  desc "Run OpenAI subagents in Claude Code and Claude subagents in Codex"
  homepage "https://github.com/wrsrsh/arelay"
  url "https://github.com/wrsrsh/arelay/releases/download/v0.2.0/arelay.tar.gz"
  sha256 "e6e2b58d236b423d01493dd9765679b62324c765c6c64e133838c3e99074300d"
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
      Choose providers, models, credentials, and routes: arelay setup
      Before uninstalling: arelay unsetup both && arelay service uninstall
      Open setup and enable the login service: arelay install
      For unattended installation: arelay install --no-interactive
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/arelay --version").strip
    assert_match "cross-provider subagents", shell_output("#{bin}/arelay --help")
  end
end
