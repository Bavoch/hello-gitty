fn main() {
    // 前端是无打包器的静态目录，显式声明为构建输入，避免仅改 JS/CSS/HTML 时复用旧资源。
    println!("cargo:rerun-if-changed=../src");
    tauri_build::build()
}
