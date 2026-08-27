cmake_minimum_required(VERSION 3.22.1)
project(ultra_llm CXX)

set(CMAKE_CXX_STANDARD 17)

# llama.cpp static libs + headers, built once for arm64 (see DEVLOG session 15).
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
