class Arelay < Formula
  desc "Delegate between Claude Code and Codex using their native CLIs"
  homepage "https://github.com/wrsrsh/arelay"
  url "https://github.com/wrsrsh/arelay/releases/download/v0.3.1/arelay.tar.gz"
  sha256 "23171f5f36718fa5737f5c739eede13c4b94c61cf1b2a26e35f42635655c4a8a"
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
      Use your working Codex provider and Claude Code login.
      Connect native workers: arelay setup
      Optional API keys or Azure: arelay setup --api
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
