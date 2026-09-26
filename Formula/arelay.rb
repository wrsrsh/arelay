class Arelay < Formula
  desc "Delegate between Claude Code and Codex using their native CLIs"
  homepage "https://github.com/wrsrsh/arelay"
  url "https://github.com/wrsrsh/arelay/releases/download/v0.4.0/arelay.tar.gz"
  sha256 "122f1d4cd5f3c4da8981c953b04b628fb2e4ed5d719747ca645ceba8463459ab"
  license all_of: ["MIT", "Apache-2.0", "BSD-3-Clause"]

  depends_on "node"

  def install
    libexec.install "arelay.mjs"
    libexec.install "LICENSE", "LICENSE.openai-codex", "THIRD_PARTY_NOTICES.md"
    bin.install_symlink libexec/"arelay.mjs" => "arelay"
  end

  def caveats
    <<~EOS
      Connect your CLIs and start at login: arelay install
      Before uninstalling: arelay unsetup both && arelay service uninstall
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/arelay --version").strip
    assert_match "cross-provider subagents", shell_output("#{bin}/arelay --help")
  end
end
