class Arelay < Formula
  desc "Delegate between Claude Code and Codex using their native CLIs"
  homepage "https://github.com/wrsrsh/arelay"
  url "https://github.com/wrsrsh/arelay/releases/download/v0.3.2/arelay.tar.gz"
  sha256 "b29a7ef4c016197c7b57d1d819b88aaafe0ab703d8fc86f48210b47de2bf3294"
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
