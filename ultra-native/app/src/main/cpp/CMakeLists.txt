cmake_minimum_required(VERSION 3.22.1)
project(ultra_llm CXX)

set(CMAKE_CXX_STANDARD 17)

# llama.cpp static libs + headers, built once for arm64 (see DEVLOG session 15).
# Nothing is built for any other ABI: the x86_64 emulator build (-Pbench, for the
# AndroidWorld benchmark) ships without the on-device model rather than failing to link.
if(NOT ANDROID_ABI STREQUAL "arm64-v8a")
    message(STATUS "ultra_llm: skipping ABI ${ANDROID_ABI} (llama.cpp is built for arm64 only)")
    return()
endif()

set(LLAMA_HOME "$ENV{HOME}/llama-android")

add_library(ultra_llm SHARED ultra_llm.cpp)

target_include_directories(ultra_llm PRIVATE ${LLAMA_HOME}/include)

target_link_directories(ultra_llm PRIVATE ${LLAMA_HOME}/lib)

target_link_libraries(ultra_llm
        llama
        ggml-cpu
        ggml-base
        ggml
        log
        atomic
        )
