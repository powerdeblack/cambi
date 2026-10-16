//! Programa que não faz nada: só existe para testar upgrade e extensão pelo cofre de uma multisig.
#![no_std]

#[no_mangle]
pub extern "C" fn entrypoint(_input: *mut u8) -> u64 {
    0
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
