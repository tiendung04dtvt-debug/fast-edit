# Third-party software and model notices

This file records the intended TTS backend components. Before distributing a built application, regenerate the complete dependency inventory from the exact environment and include every upstream notice and license text.

| Component | Intended role | License reference |
| --- | --- | --- |
| [VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS) | Vietnamese TTS SDK | Apache-2.0; retain upstream notices and attribution. |
| [VieNeu-TTS v3 Turbo model](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo) | Model and preset voices | Model card states Apache-2.0 applies to the released weights and bundled preset voice assets; retain its attribution. |
| [MOSS Audio Tokenizer Nano](https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano) | Audio codec component used by VieNeu | Apache-2.0 according to its model card; retain its notices. |
| [SEA-G2P](https://github.com/pnnbao97/sea-g2p) | Vietnamese phonemizer used by VieNeu | Retain the license and notices from the exact installed distribution. |
| [KorvaTTS](https://github.com/dogenthq/KorvaTTS) | ONNX TTS fallback | Repository states Apache-2.0 for code and weights; retain NOTICE and attribution. |
| [PyTorch](https://github.com/pytorch/pytorch) | Optional CUDA backend | BSD-style license; include its license and dependency notices if redistributed. |
| [PyInstaller](https://pyinstaller.org/en/stable/license.html) | Builds the portable backend | GPL with a bootloader exception for bundled executables; do not modify PyInstaller's own code without reviewing its terms. |
| [FFmpeg](https://ffmpeg.org/legal.html) | Video rendering | LGPL v2.1+ / v3 (BtbN/FFmpeg-Builds win64-lgpl). Bundled binary compiled without `--enable-gpl` or `--enable-nonfree`. Upstream source code available at https://github.com/BtbN/FFmpeg-Builds. |
| Arial Font | Video captioning | System font dynamically referenced from `C:\Windows\Fonts\arial.ttf` at runtime; the font file is NOT bundled or redistributed with this application. |

The current VieNeu Python package lists `sea-g2p` as its phonemizer dependency. eSpeak NG is not listed as a required dependency in the current package metadata, so this project does not install or bundle eSpeak NG. If that changes, review its GPL-3.0-or-later terms separately.

This inventory is not a legal opinion and is not a substitute for checking the exact package artifacts and transitive dependencies used in a release.
