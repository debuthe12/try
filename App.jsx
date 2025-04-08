import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Platform // Keep for potential future use
} from 'react-native';
import Video from 'react-native-video';
import dgram from 'react-native-udp';
import { FFmpegKit, ReturnCode, FFmpegKitConfig } from 'ffmpeg-kit-react-native';

// --- Constants ---
const TELLO_IP = '192.168.10.1';
const TELLO_COMMAND_PORT = 8889;
const TELLO_VIDEO_PORT = 11111; // Tello sends video stream here

const LOCAL_COMMAND_PORT_BIND = 9000; // Local port for sending/receiving commands
const LOCAL_VIDEO_INPUT_PORT = TELLO_VIDEO_PORT; // Port FFmpeg listens on
const LOCAL_VIDEO_OUTPUT_HTTP_PORT = 11112; // Port FFmpeg serves HTTP stream

const App = () => {
  const [errorMessage, setErrorMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false); // Simple flag
  const commandSocket = useRef(null);
  const ffmpegSessionId = useRef(null);
  const videoPlayerRef = useRef(null);

  // --- Simplified Cleanup ---
  const cleanup = useCallback(async () => {
    console.log('Cleaning up...');
    setIsStreaming(false);
    setErrorMessage('');

    // Cancel FFmpeg
    if (ffmpegSessionId.current) {
      console.log('Cancelling FFmpeg session:', ffmpegSessionId.current);
      try {
        await FFmpegKit.cancel(ffmpegSessionId.current);
      } catch (e) {
        console.error("Error cancelling FFmpeg session:", e);
      } finally {
        ffmpegSessionId.current = null;
      }
    }

    // Close UDP socket
    if (commandSocket.current) {
      console.log('Closing UDP socket');
       try {
           commandSocket.current.close();
       } catch(e) {
           console.error("Error closing socket:", e);
       } finally {
          commandSocket.current = null;
       }
    }
  }, []);

  // --- Setup & Teardown Effects ---
  useEffect(() => {
    // Enable FFmpegKit logs - VERY IMPORTANT FOR DEBUGGING FFmpeg
    FFmpegKitConfig.enableLogCallback(log => console.log(`FFmpegKit Log: ${log.getMessage()}`));
    FFmpegKitConfig.enableStatisticsCallback(stats => console.log(`FFmpegKit Stats: ${JSON.stringify(stats)}`)); // Can be noisy, but useful

    // Cleanup on component unmount
    return () => {
      cleanup();
    };
  }, [cleanup]); // Depend on cleanup

  // --- Send Command (Corrected - No Buffer) ---
  const sendCommand = (command) => {
    return new Promise((resolve, reject) => {
      if (!commandSocket.current) {
        console.error("sendCommand: Socket not ready.");
        return reject(new Error("Socket not initialized"));
      }
      console.log(`Sending command: ${command}`);
      // Use the 'command' string directly
      commandSocket.current.send(command, 0, command.length, TELLO_COMMAND_PORT, TELLO_IP, (err) => {
        if (err) {
          console.error(`Failed to send command ${command}:`, err);
          setErrorMessage(`Failed to send command: ${err.message}`);
          reject(err);
        } else {
          console.log(`Command ${command} sent.`);
          resolve();
        }
      });
    });
  };

  // --- Start FFmpeg Process ---
  const startFFmpeg = async () => {
    // Reset previous errors if any
    setErrorMessage('');

    // Ensure no lingering session
    if (ffmpegSessionId.current) {
        console.warn("FFmpeg session already exists, cancelling previous one.");
        await FFmpegKit.cancel(ffmpegSessionId.current);
        ffmpegSessionId.current = null;
    }

    // --- FFmpeg Command (Corrected - Removed unsupported UDP options) ---
    const ffmpegCommand = `-f h264 -analyzeduration 1000000 -probesize 1000000 -fflags discardcorrupt -fflags nobuffer -flags low_delay -avioflags direct -i udp://0.0.0.0:${LOCAL_VIDEO_INPUT_PORT}?timeout=5000000 -c:v copy -f mpegts -listen 1 http://127.0.0.1:${LOCAL_VIDEO_OUTPUT_HTTP_PORT}`;
    // Note: Removed '&fifo_size=1000000&overrun_nonfatal=1' from the UDP URL


    console.log("Starting FFmpeg with command:", ffmpegCommand);

    try {
      // Execute FFmpeg asynchronously
      const session = await FFmpegKit.executeAsync(ffmpegCommand,
        async (completedSession) => {
            // --- FFmpeg Completion Callback ---
            const returnCode = await completedSession.getReturnCode();
            const sessionId = completedSession.getSessionId();
            console.log(`FFmpeg session ${sessionId} completed.`);

            // Clear the session ID regardless of outcome for this specific session
             if (ffmpegSessionId.current === sessionId) {
                 ffmpegSessionId.current = null;
             }

            if (ReturnCode.isSuccess(returnCode)) {
                console.log('FFmpeg process finished successfully.');
                if (isStreaming) {
                    console.warn("FFmpeg exited successfully while streaming was active.");
                    // setErrorMessage("Stream ended."); // Optional
                    // setIsStreaming(false);
                }
            } else if (ReturnCode.isCancel(returnCode)) {
                console.log('FFmpeg process cancelled.'); // Expected on cleanup
            } else {
                // ***** KEY ERROR HANDLING *****
                console.error('FFmpeg process failed!');
                const logs = await completedSession.getAllLogsAsString(); // Get ALL logs
                console.error('------ FFmpeg Logs Start ------');
                console.error(logs || 'No logs captured.'); // Log the detailed FFmpeg output
                console.error('------ FFmpeg Logs End --------');
                setErrorMessage('FFmpeg Error! Check console logs for details.');
                setIsStreaming(false); // Stop showing video on FFmpeg error
                // ***** END KEY ERROR HANDLING *****
            }
        }
      );

      ffmpegSessionId.current = await session.getSessionId();
      console.log('FFmpeg session starting with ID:', ffmpegSessionId.current);
      // Set streaming true, player will handle its own load/error state visually
      setIsStreaming(true);

    } catch (error) {
      console.error('Failed to execute FFmpeg command:', error);
      setErrorMessage(`Failed to start FFmpeg: ${error.message}`);
      setIsStreaming(false);
    }
  };


  // --- Button Handler: Initialize and Start ---
  const handleStartStream = async () => {
    if (isStreaming || commandSocket.current || ffmpegSessionId.current) {
        console.log("Already streaming or attempting to start.");
        return;
    }

    setErrorMessage(''); // Clear previous errors
    setIsStreaming(false); // Reset streaming state initially

    try {
      // 1. Create Socket
      console.log('Creating UDP command socket...');
      commandSocket.current = dgram.createSocket({ type: 'udp4' });

      // Basic error handler
      commandSocket.current.on('error', (err) => {
        const errorMsg = `UDP Socket error: ${err.message}`;
        console.error(errorMsg, err);
        setErrorMessage(errorMsg);
        cleanup(); // Cleanup on socket error
      });

      // Basic message handler (just logs responses)
      commandSocket.current.on('message', (msg, rinfo) => {
        console.log(`Drone response: ${msg.toString()} from ${rinfo.address}:${rinfo.port}`);
      });

      // 2. Bind Socket
      await new Promise((resolve, reject) => {
        commandSocket.current.bind(LOCAL_COMMAND_PORT_BIND, (err) => {
          if (err) {
            const bindError = `Failed to bind socket to port ${LOCAL_COMMAND_PORT_BIND}: ${err.message}`;
            console.error('Socket bind error:', bindError);
            reject(new Error(bindError));
          } else {
            console.log(`Socket bound successfully to port ${LOCAL_COMMAND_PORT_BIND}`);
            resolve();
          }
        });
      });

      // 3. Send Initial Commands (with simple delays)
      await sendCommand('command');
      await new Promise(resolve => setTimeout(resolve, 500)); // Simple delay

      await sendCommand('streamon');
      await new Promise(resolve => setTimeout(resolve, 500)); // Simple delay

      console.log("Drone commands sent. Starting FFmpeg...");

      // 4. Start FFmpeg
      await startFFmpeg();

    } catch (error) {
      console.error("Initialization failed:", error);
      setErrorMessage(`Initialization failed: ${error.message}`);
      await cleanup(); // Ensure cleanup on failure
    }
  };

  // --- Button Handler for Disconnect ---
  const handleDisconnectPress = () => {
    console.log("Disconnect button pressed.");
    cleanup(); // Trigger manual cleanup
  }

  // --- Video Player Callbacks ---
  const onVideoLoad = () => {
    console.log('Video player loaded stream successfully!');
    // Clear errors if video loads after a previous failure
    if (errorMessage) {
        setErrorMessage('');
    }
  };

  const onVideoError = (err) => {
    // ***** VIDEO PLAYER ERROR HANDLING *****
    console.error('Video player error:', JSON.stringify(err, null, 2)); // Log the full error object
    const videoErrorMsg = err.error?.localizedDescription || err.error?.localizedFailureReason || err.error?.message || 'Unknown video player error';
    setErrorMessage(`Video Player Error: ${videoErrorMsg}. Check console.`);
    // Consider setting isStreaming to false or adding retry logic if desired
    // setIsStreaming(false);
    // ***** END VIDEO PLAYER ERROR HANDLING *****
  };


  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>

        {/* Error Display Area */}
        {errorMessage ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}

        {/* Video Area */}
        <View style={styles.videoContainer}>
          {isStreaming ? (
            <Video
              ref={videoPlayerRef}
              source={{ uri: `http://127.0.0.1:${LOCAL_VIDEO_OUTPUT_HTTP_PORT}` }}
              style={styles.video}
              resizeMode="contain"
              onError={onVideoError} // Use the error handler
              onLoad={onVideoLoad}   // Use the load handler
              // *** REMOVED bufferConfig prop to use defaults ***
              repeat={false}
              muted={false}
              allowsExternalPlayback={false}
              paused={!isStreaming} // Explicitly pause if not streaming
            />
          ) : (
            <View style={styles.placeholder}>
              <Text>Stream Paused / Disconnected</Text>
            </View>
          )}
        </View>

        {/* Control Buttons */}
        <View style={styles.buttonContainer}>
          {!isStreaming && !commandSocket.current && !ffmpegSessionId.current ? ( // Show Start only when fully disconnected
              <TouchableOpacity
                style={styles.button}
                onPress={handleStartStream}
              >
                <Text style={styles.buttonText}>Start Stream</Text>
              </TouchableOpacity>
           ) : (
              <TouchableOpacity
                style={[styles.button, styles.disconnectButton]}
                onPress={handleDisconnectPress}
              >
                <Text style={styles.buttonText}>Disconnect</Text>
              </TouchableOpacity>
           )}
        </View>
      </View>
    </SafeAreaView>
  );
};

// --- Styles (Simplified) ---
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#e0e0e0',
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
  },
  errorContainer: {
    backgroundColor: '#ffcdd2', // Light red
    padding: 10,
    margin: 10,
    borderRadius: 4,
    position: 'absolute', // Overlay on top
    top: 10,
    left: 10,
    right: 10,
    zIndex: 10, // Ensure it's above video
  },
  errorText: {
    color: '#b71c1c', // Dark red
    fontSize: 14,
    textAlign: 'center',
  },
  videoContainer: {
    flex: 1, // Take available space
    backgroundColor: '#000',
    marginVertical: 10, // Some margin around video
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#666', // Dark placeholder
  },
  buttonContainer: {
    padding: 20,
    paddingBottom: 40, // Extra padding at bottom
  },
  button: {
    backgroundColor: '#2196F3', // Blue
    paddingVertical: 15,
    borderRadius: 8,
    alignItems: 'center',
  },
  disconnectButton: {
      backgroundColor: '#f44336', // Red
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});

export default App;